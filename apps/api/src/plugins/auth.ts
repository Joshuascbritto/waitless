import { and, type Db, eq, memberships, tenants } from "@waitless/db";
import { NotFoundError, type TenantContext, UnauthorizedError } from "@waitless/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  findSession,
  renewSession,
  SESSION_COOKIE,
  type SessionUser,
  shouldRenewSession,
} from "../auth/sessions.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `requireUser`. */
    user: SessionUser | null;
    /** Set by `requireTenantMember`, on /api/admin/:tenantSlug routes. */
    tenantContext: TenantContext | null;
  }
  interface FastifyInstance {
    requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireTenantMember(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, // not readable from JavaScript, so XSS can't steal it
    secure: true, // HTTPS only (browsers treat http://localhost as secure)
    sameSite: "lax", // not sent on cross-site POSTs: CSRF layer 1
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
}

/**
 * Registers `app.requireUser` and `app.requireTenantMember`, used as
 * preHandlers. Called on the root instance so every route can use them.
 */
export function registerAuth(app: FastifyInstance, db: Db): void {
  app.decorateRequest("user", null);
  app.decorateRequest("tenantContext", null);

  app.decorate("requireUser", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      throw new UnauthorizedError("Sign in to continue");
    }

    const now = new Date();
    const session = await findSession(db, token, now);
    if (!session) {
      clearSessionCookie(reply);
      throw new UnauthorizedError("Your session has expired. Sign in again");
    }

    if (shouldRenewSession(session.expiresAt, now)) {
      setSessionCookie(reply, token, await renewSession(db, session.id, now));
    }
    request.user = session.user;
  });

  app.decorate("requireTenantMember", async (request: FastifyRequest) => {
    const user = request.user;
    if (!user) {
      throw new Error("requireTenantMember must run after requireUser");
    }
    const { tenantSlug } = request.params as { tenantSlug: string };

    const [tenant] = await db.global
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        timezone: tenants.timezone,
      })
      .from(tenants)
      .where(eq(tenants.slug, tenantSlug));

    // The membership row is read as the user (dual-key policy), before any tenant context exists.
    const [membership] = tenant
      ? await db.withUser(user.id, (tx) =>
          tx
            .select({ role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, user.id))),
        )
      : [];

    // Same answer whether the tenant doesn't exist or the user isn't a member:
    // a 403 would confirm to outsiders that the slug exists.
    if (!tenant || !membership) {
      throw new NotFoundError("Tenant not found");
    }
    request.tenantContext = { tenant, role: membership.role as TenantContext["role"] };
  });
}
