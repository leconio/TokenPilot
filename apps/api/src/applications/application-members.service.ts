import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import {
  ApplicationRole,
  Prisma,
  applicationPermissionsForWrite,
  effectiveApplicationPermissions,
  type DatabaseClient,
} from "@tokenpilot/db";

import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { WebAuthService } from "../web-auth.service.js";
import {
  createApplicationMemberSchema,
  updateApplicationMemberSchema,
} from "./application.schemas.js";

const rolesByName = {
  owner: ApplicationRole.OWNER,
  admin: ApplicationRole.ADMIN,
  analyst: ApplicationRole.ANALYST,
  viewer: ApplicationRole.VIEWER,
} as const;

function presentMember(member: {
  readonly userId: string;
  readonly role: ApplicationRole;
  readonly permissions: readonly string[];
  readonly createdAt: Date;
  readonly user: { readonly name: string; readonly email: string };
}) {
  return {
    user_id: member.userId,
    name: member.user.name,
    email: member.user.email,
    role: member.role.toLowerCase(),
    permissions: effectiveApplicationPermissions(member.role, member.permissions),
    created_at: member.createdAt.toISOString(),
  };
}

@Injectable()
export class ApplicationMembersService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(WebAuthService) private readonly webAuth: WebAuthService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async userId(request: FastifyRequest): Promise<string> {
    const identity = await this.webAuth.authenticate(request.headers.cookie);
    if (identity === null) throw new UnauthorizedException("A web session is required");
    return identity.userId;
  }

  private async application(request: FastifyRequest, slug: string) {
    const userId = await this.userId(request);
    const application = await this.database.application.findFirst({
      where: { slug, members: { some: { userId } } },
      include: {
        members: { where: { userId }, take: 1 },
      },
    });
    if (application === null) throw new NotFoundException("Application not found");
    return { application, member: application.members[0] };
  }

  private async owner(request: FastifyRequest, slug: string) {
    const context = await this.application(request, slug);
    if (
      context.member?.role !== ApplicationRole.OWNER ||
      !effectiveApplicationPermissions(context.member.role, context.member.permissions).includes(
        "admin:write",
      )
    ) {
      throw new ForbiddenException("Only an application owner can manage members");
    }
    return context.application;
  }

  async list(request: FastifyRequest, slug: string) {
    const { application, member } = await this.application(request, slug);
    if (
      member === undefined ||
      !effectiveApplicationPermissions(member.role, member.permissions).includes("admin:read")
    ) {
      throw new ForbiddenException("Application member read permission is required");
    }
    const members = await this.database.applicationMember.findMany({
      where: { applicationId: application.id },
      include: { user: { select: { name: true, email: true } } },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });
    return { members: members.map(presentMember) };
  }

  async create(request: FastifyRequest, slug: string, input: unknown) {
    const parsed = createApplicationMemberSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid application member");
    const application = await this.owner(request, slug);
    const user = await this.database.user.findUnique({ where: { email: parsed.data.email } });
    if (user === null) throw new NotFoundException("No signed-in user has this email address");
    const role = rolesByName[parsed.data.role];
    let permissions: string[];
    try {
      permissions = applicationPermissionsForWrite(role, parsed.data.permissions);
    } catch {
      throw new BadRequestException("Permissions exceed the selected role");
    }
    try {
      const member = await this.database.$transaction(async (transaction) => {
        const created = await transaction.applicationMember.create({
          data: { applicationId: application.id, userId: user.id, role, permissions },
          include: { user: { select: { name: true, email: true } } },
        });
        await this.audit.record(
          {
            action: "application.member.create",
            objectType: "application_member",
            objectId: user.id,
            applicationId: application.id,
            after: { email: user.email, role: role.toLowerCase(), permissions },
            reason: "Added application member",
          },
          transaction,
        );
        return created;
      });
      return presentMember(member);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This user is already an application member");
      }
      throw error;
    }
  }

  async update(request: FastifyRequest, slug: string, userId: string, input: unknown) {
    const parsed = updateApplicationMemberSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid application member changes");
    const application = await this.owner(request, slug);
    return this.database.$transaction(async (transaction) => {
      const current = await transaction.applicationMember.findUnique({
        where: { applicationId_userId: { applicationId: application.id, userId } },
        include: { user: { select: { name: true, email: true } } },
      });
      if (current === null) throw new NotFoundException("Application member not found");
      const role = parsed.data.role === undefined ? current.role : rolesByName[parsed.data.role];
      if (current.role === ApplicationRole.OWNER && role !== ApplicationRole.OWNER) {
        await this.assertAnotherOwner(transaction, application.id, userId);
      }
      let permissions: string[];
      try {
        permissions = applicationPermissionsForWrite(
          role,
          parsed.data.permissions ??
            (parsed.data.role === undefined ? current.permissions : undefined),
        );
      } catch {
        throw new BadRequestException("Permissions exceed the selected role");
      }
      if (role === ApplicationRole.OWNER && !permissions.includes("admin:write")) {
        throw new BadRequestException("An owner must retain application management permission");
      }
      const updated = await transaction.applicationMember.update({
        where: { applicationId_userId: { applicationId: application.id, userId } },
        data: { role, permissions },
        include: { user: { select: { name: true, email: true } } },
      });
      await this.audit.record(
        {
          action: "application.member.update",
          objectType: "application_member",
          objectId: userId,
          applicationId: application.id,
          before: { role: current.role.toLowerCase(), permissions: current.permissions },
          after: { role: role.toLowerCase(), permissions },
          reason: "Updated application member",
        },
        transaction,
      );
      return presentMember(updated);
    });
  }

  async remove(request: FastifyRequest, slug: string, userId: string) {
    const application = await this.owner(request, slug);
    await this.database.$transaction(async (transaction) => {
      const current = await transaction.applicationMember.findUnique({
        where: { applicationId_userId: { applicationId: application.id, userId } },
        include: { user: { select: { email: true } } },
      });
      if (current === null) throw new NotFoundException("Application member not found");
      if (current.role === ApplicationRole.OWNER) {
        await this.assertAnotherOwner(transaction, application.id, userId);
      }
      await this.audit.record(
        {
          action: "application.member.remove",
          objectType: "application_member",
          objectId: userId,
          applicationId: application.id,
          before: { email: current.user.email, role: current.role.toLowerCase() },
          reason: "Removed application member",
        },
        transaction,
      );
      await transaction.applicationMember.delete({
        where: { applicationId_userId: { applicationId: application.id, userId } },
      });
    });
    return { removed: true };
  }

  private async assertAnotherOwner(
    transaction: {
      readonly applicationMember: {
        count(input: {
          readonly where: {
            readonly applicationId: string;
            readonly role: ApplicationRole;
            readonly userId: { readonly not: string };
          };
        }): Promise<number>;
      };
    },
    applicationId: string,
    excludedUserId: string,
  ): Promise<void> {
    const owners = await transaction.applicationMember.count({
      where: { applicationId, role: ApplicationRole.OWNER, userId: { not: excludedUserId } },
    });
    if (owners === 0) throw new ConflictException("An application must keep at least one owner");
  }
}
