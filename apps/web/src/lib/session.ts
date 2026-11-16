import { type MeResponse, MeResponseSchema } from "@waitless/shared";
import { cookies } from "next/headers";
import { cache } from "react";
import { resolveApiOrigin } from "./api-origin";

const SESSION_COOKIE = "__Host-waitless_session";

/**
 * Server-side GET to the API. Server components call the API directly (not
 * through the /api rewrite) and forward the session cookie, so protected
 * pages can redirect before rendering instead of flashing.
 *
 * Note: a sliding-expiry renewal the API sends here can't reach the browser
 * (server components can't set cookies); the browser's own /api calls renew it.
 */
export async function serverGet(path: `/api/${string}`): Promise<Response> {
  const session = (await cookies()).get(SESSION_COOKIE);
  return fetch(`${resolveApiOrigin(process.env.API_ORIGIN)}${path}`, {
    headers: session ? { cookie: `${SESSION_COOKIE}=${session.value}` } : {},
    cache: "no-store",
  });
}

/** Who is signed in, or null. Memoized per request: layout and page share one call. */
export const getMe = cache(async (): Promise<MeResponse | null> => {
  if (!(await cookies()).get(SESSION_COOKIE)) {
    return null;
  }
  const response = await serverGet("/api/auth/me");
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GET /api/auth/me failed with ${response.status}`);
  }
  return MeResponseSchema.parse(await response.json());
});
