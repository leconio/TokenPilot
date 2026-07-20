import { randomBytes } from "node:crypto";

import type { DatabaseClient } from "./client.js";
import { ApplicationRole, ApplicationStatus, Prisma } from "./generated/prisma/client.js";

export interface CreateApplicationInput {
  readonly name: string;
  readonly ownerUserId: string;
  readonly timezone?: string;
  readonly baseCurrency?: string;
}

export const APPLICATION_MEMBER_PERMISSIONS = [
  "usage:read",
  "model:read",
  "model:write",
  "configuration:read",
  "configuration:write",
  "admin:read",
  "admin:write",
  "pricing:read",
  "pricing:write",
  "reports:read",
  "jobs:read",
  "jobs:write",
  "reconciliation:read",
  "reconciliation:write",
] as const;

export type ApplicationMemberPermission = (typeof APPLICATION_MEMBER_PERMISSIONS)[number];

const readPermissions: readonly ApplicationMemberPermission[] = [
  "usage:read",
  "model:read",
  "configuration:read",
  "admin:read",
  "pricing:read",
  "reports:read",
];

const rolePermissions: Readonly<Record<ApplicationRole, readonly ApplicationMemberPermission[]>> = {
  [ApplicationRole.OWNER]: APPLICATION_MEMBER_PERMISSIONS,
  [ApplicationRole.ADMIN]: APPLICATION_MEMBER_PERMISSIONS,
  [ApplicationRole.ANALYST]: [...readPermissions, "jobs:read", "reconciliation:read"],
  [ApplicationRole.VIEWER]: readPermissions,
};

export function defaultApplicationPermissions(
  role: ApplicationRole,
): readonly ApplicationMemberPermission[] {
  return rolePermissions[role];
}

export function effectiveApplicationPermissions(
  role: ApplicationRole,
  storedPermissions: readonly string[],
  allowedPermissions: readonly string[] = APPLICATION_MEMBER_PERMISSIONS,
): ApplicationMemberPermission[] {
  const roleAllowed = new Set<string>(rolePermissions[role]);
  const platformAllowed = new Set(allowedPermissions);
  return [
    ...new Set(
      storedPermissions.filter(
        (permission): permission is ApplicationMemberPermission =>
          roleAllowed.has(permission) && platformAllowed.has(permission),
      ),
    ),
  ];
}

export function applicationPermissionsForWrite(
  role: ApplicationRole,
  permissions?: readonly string[],
): ApplicationMemberPermission[] {
  const requested = permissions ?? defaultApplicationPermissions(role);
  const effective = effectiveApplicationPermissions(role, requested);
  if (effective.length !== new Set(requested).size) {
    throw new TypeError("Application member permissions exceed the selected role");
  }
  return effective;
}

export function applicationSlugBase(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 96)
    .replaceAll(/-+$/gu, "");
  return normalized.length === 0 ? "app" : normalized;
}

function assertApplicationInput(input: CreateApplicationInput): {
  readonly name: string;
  readonly timezone: string;
  readonly baseCurrency: string;
} {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 120) {
    throw new TypeError("Application name must contain between 1 and 120 characters");
  }
  const timezone = input.timezone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new TypeError("Application timezone must be a valid IANA timezone");
  }
  const baseCurrency = (input.baseCurrency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/u.test(baseCurrency)) {
    throw new TypeError("Application base currency must be a three-letter code");
  }
  return { name, timezone, baseCurrency };
}

export async function createApplication(database: DatabaseClient, input: CreateApplicationInput) {
  const value = assertApplicationInput(input);
  const base = applicationSlugBase(value.name);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
    try {
      return await database.application.create({
        data: {
          name: value.name,
          slug,
          timezone: value.timezone,
          baseCurrency: value.baseCurrency,
          settings: { create: {} },
          members: {
            create: {
              userId: input.ownerUserId,
              role: ApplicationRole.OWNER,
              permissions: applicationPermissionsForWrite(ApplicationRole.OWNER),
            },
          },
        },
        include: { settings: true },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
    }
  }
  throw new Error("Could not allocate a unique application slug");
}

export async function listApplicationsForUser(database: DatabaseClient, userId: string) {
  return database.application.findMany({
    where: {
      status: ApplicationStatus.ACTIVE,
      members: { some: { userId } },
    },
    include: {
      members: { where: { userId }, select: { role: true, permissions: true } },
    },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
  });
}

export async function listManagedApplicationsForUser(database: DatabaseClient, userId: string) {
  return database.application.findMany({
    where: { members: { some: { userId } } },
    include: {
      members: { where: { userId }, select: { role: true, permissions: true } },
      _count: { select: { members: true } },
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }, { name: "asc" }],
  });
}

export async function findApplicationForUser(
  database: DatabaseClient,
  userId: string,
  slug: string,
) {
  return database.application.findFirst({
    where: { slug, members: { some: { userId } } },
    include: {
      settings: true,
      members: { where: { userId }, select: { role: true, permissions: true } },
    },
  });
}
