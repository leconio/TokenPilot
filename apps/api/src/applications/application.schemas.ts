import { z } from "zod";

import { APPLICATION_MEMBER_PERMISSIONS } from "@tokenpilot/db";

export const applicationRoleSchema = z.enum(["owner", "admin", "analyst", "viewer"]);
const permissionsSchema = z.array(z.enum(APPLICATION_MEMBER_PERMISSIONS)).max(32);

export const createApplicationSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});

export const updateApplicationSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(128).optional(),
    base_currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one change");

export const archiveApplicationSchema = z.strictObject({
  confirmation_name: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(5).max(500),
});

export const createApplicationMemberSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(320),
  role: applicationRoleSchema.default("viewer"),
  permissions: permissionsSchema.optional(),
});

export const updateApplicationMemberSchema = z
  .strictObject({
    role: applicationRoleSchema.optional(),
    permissions: permissionsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Expected at least one member change");
