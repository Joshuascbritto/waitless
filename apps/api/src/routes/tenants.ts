import { createTenantWithOwner, type Db, isUniqueViolation } from "@waitless/db";
import { ConflictError, CreateTenantInputSchema, TenantSchema } from "@waitless/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

/** POST /api/tenants: any signed-in user can open a business and becomes its owner. */
export const tenantRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.post(
    "/",
    {
      preHandler: app.requireUser,
      schema: {
        body: CreateTenantInputSchema,
        response: { 201: z.object({ tenant: TenantSchema }) },
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        throw new Error("requireUser did not set request.user");
      }

      const tenant = await createTenantWithOwner(db, request.body, user.id).catch(
        (error: unknown) => {
          throw isUniqueViolation(error)
            ? new ConflictError("That address is already taken")
            : error;
        },
      );
      return reply.code(201).send({
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, timezone: tenant.timezone },
      });
    },
  );
};
