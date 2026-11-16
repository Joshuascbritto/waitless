import { z } from "zod";

/** Trimmed and lowercased before validation, so "Ana@X.com " and "ana@x.com" are one account. */
export const EmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/**
 * NIST 800-63B: at least 8 characters, no composition rules. The upper bound
 * keeps a huge password from turning argon2 hashing into a DoS vector.
 */
export const NewPasswordSchema = z.string().min(8).max(256);

export const DisplayNameSchema = z.string().trim().min(1).max(100);

export const RegisterInputSchema = z.object({
  email: EmailSchema,
  password: NewPasswordSchema,
  name: DisplayNameSchema,
});
export type RegisterInput = z.infer<typeof RegisterInputSchema>;

export const LoginInputSchema = z.object({
  email: EmailSchema,
  // No min length on login: rules may change, old passwords must still be accepted.
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const RoleSchema = z.enum(["owner", "staff"]);
export type Role = z.infer<typeof RoleSchema>;

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const MembershipSchema = z.object({
  tenantId: z.uuid(),
  tenantSlug: z.string(),
  tenantName: z.string(),
  role: RoleSchema,
});
export type Membership = z.infer<typeof MembershipSchema>;

export const MeResponseSchema = z.object({
  user: UserSchema,
  memberships: z.array(MembershipSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
