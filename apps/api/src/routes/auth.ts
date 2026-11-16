import { type Db, eq, isUniqueViolation, memberships, tenants, users } from "@waitless/db";
import {
  ConflictError,
  LoginInputSchema,
  MeResponseSchema,
  RegisterInputSchema,
  type Role,
  UnauthorizedError,
  UserSchema,
} from "@waitless/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../auth/passwords.ts";
import { createSession, deleteSession, SESSION_COOKIE } from "../auth/sessions.ts";
import { clearSessionCookie, setSessionCookie } from "../plugins/auth.ts";

const UserResponse = z.object({ user: UserSchema });

export const authRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.post(
    "/register",
    {
      schema: { body: RegisterInputSchema, response: { 201: UserResponse } },
    },
    async (request, reply) => {
      const { email, password, name } = request.body;
      const passwordHash = await hashPassword(password);

      const [user] = await db.global
        .insert(users)
        .values({ email, name, passwordHash })
        .returning({ id: users.id, email: users.email, name: users.name })
        .catch((error: unknown) => {
          throw isUniqueViolation(error)
            ? new ConflictError("An account with this email already exists")
            : error;
        });
      if (!user) {
        throw new Error("user insert returned no row");
      }

      const session = await createSession(db, user.id, new Date());
      setSessionCookie(reply, session.token, session.expiresAt);
      return reply.code(201).send({ user });
    },
  );

  app.post(
    "/login",
    {
      schema: { body: LoginInputSchema, response: { 200: UserResponse } },
      config: {
        // Brute-force guard (SPEC §9). Runs after validation, so the key can use the email.
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (request) => {
            const { email } = request.body as { email: string };
            return `login:${request.ip}:${email}`;
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const [user] = await db.global.select().from(users).where(eq(users.email, email));

      const valid = user
        ? await verifyPassword(user.passwordHash, password)
        : await verifyAgainstDummy(password);
      if (!user || !valid) {
        // One message for both cases, so the response doesn't reveal which emails exist.
        throw new UnauthorizedError("Invalid email or password");
      }

      // Always a new session id on login: an id planted before login is useless (session fixation).
      const session = await createSession(db, user.id, new Date());
      setSessionCookie(reply, session.token, session.expiresAt);
      return { user: { id: user.id, email: user.email, name: user.name } };
    },
  );

  app.post("/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await deleteSession(db, token);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get(
    "/me",
    {
      preHandler: app.requireUser,
      schema: { response: { 200: MeResponseSchema } },
    },
    async (request) => {
      const user = request.user;
      if (!user) {
        throw new Error("requireUser did not set request.user");
      }

      const rows = await db.withUser(user.id, (tx) =>
        tx
          .select({
            tenantId: memberships.tenantId,
            tenantSlug: tenants.slug,
            tenantName: tenants.name,
            role: memberships.role,
          })
          .from(memberships)
          .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
          .where(eq(memberships.userId, user.id))
          .orderBy(tenants.name),
      );

      return {
        user,
        memberships: rows.map((row) => ({ ...row, role: row.role as Role })),
      };
    },
  );
};
