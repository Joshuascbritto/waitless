import { z } from "zod";
import { RoleSchema } from "./auth.ts";

/**
 * URL-safe tenant slug: lowercase letters, digits and single hyphens, e.g.
 * "barbearia-do-ze". It appears in every customer and admin URL.
 */
export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens");

/** IANA timezone the runtime knows (works in Node and browsers). */
export const TimezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Unknown timezone" },
);

export const CreateTenantInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: SlugSchema,
  timezone: TimezoneSchema.default("America/Bahia"),
});
export type CreateTenantInput = z.infer<typeof CreateTenantInputSchema>;

export const TenantSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
});
export type Tenant = z.infer<typeof TenantSchema>;

/** What the admin area knows about the tenant it's in. */
export const TenantContextSchema = z.object({
  tenant: TenantSchema,
  role: RoleSchema,
});
export type TenantContext = z.infer<typeof TenantContextSchema>;
