import { type MeResponse, MeResponseSchema } from "@waitless/shared";
import { cookies } from "next/headers";
import { resolveApiOrigin } from "./api-origin";

const SESSION_COOKIE = "__Host-waitless_session";

/**
 * Server-side: who is signed in, or null. Server components call the API
 * directly (not through the /api rewrite) and forward the session cookie, so
 * protected pages redirect before rendering instead of flashing.
 *
 * Note: a sliding-expiry renewal the API sends here can't reach the browser
 * (server components can't set cookies); the browser's own /api calls renew it.
 */
export async function getMe(): Promise<MeResponse | null> {
  const session = (await cookies()).get(SESSION_COOKIE);
  if (!session) {
    return null;
  }

  const response = await fetch(`${resolveApiOrigin(process.env.API_ORIGIN)}/api/auth/me`, {
    headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
    cache: "no-store",
  });
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GET /api/auth/me failed with ${response.status}`);
  }
  return MeResponseSchema.parse(await response.json());
}
