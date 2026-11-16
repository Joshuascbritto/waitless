import { createHash, randomBytes } from "node:crypto";
import { and, type Db, eq, gt, sessions, users } from "@waitless/db";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * `__Host-` prefix: the browser only accepts this cookie if it is Secure,
 * has Path=/ and no Domain, so a sibling subdomain can't overwrite it.
 */
export const SESSION_COOKIE = "__Host-waitless_session";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** 256 random bits, base64url. Lives only in the cookie. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The database stores sha256(token), never the token. A leaked sessions table
 * (backup, SQL injection) can't be replayed as cookies. A plain hash is enough
 * here, unlike passwords: the input is already 256 bits of randomness.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Sliding expiry without a write per request: extend the session only once
 * less than half of its lifetime remains. An active user is renewed at most
 * about once a week and never logged out; an idle one expires after 14 days.
 */
export function shouldRenewSession(expiresAt: Date, now: Date, ttlMs = SESSION_TTL_MS): boolean {
  const remainingMs = expiresAt.getTime() - now.getTime();
  return remainingMs > 0 && remainingMs < ttlMs / 2;
}

export async function createSession(
  db: Db,
  userId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.global.insert(sessions).values({ id: hashSessionToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function findSession(
  db: Db,
  token: string,
  now: Date,
): Promise<{ id: string; expiresAt: Date; user: SessionUser } | undefined> {
  const [row] = await db.global
    .select({
      id: sessions.id,
      expiresAt: sessions.expiresAt,
      user: { id: users.id, email: users.email, name: users.name },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hashSessionToken(token)), gt(sessions.expiresAt, now)));
  return row;
}

export async function renewSession(db: Db, sessionId: string, now: Date): Promise<Date> {
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.global.update(sessions).set({ expiresAt }).where(eq(sessions.id, sessionId));
  return expiresAt;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.global.delete(sessions).where(eq(sessions.id, hashSessionToken(token)));
}
