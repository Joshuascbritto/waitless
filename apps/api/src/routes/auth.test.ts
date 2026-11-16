import { eq, sessions, users } from "@waitless/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  type Harness,
  registerUser,
  sessionCookieFrom,
  startHarness,
  uniqueEmail,
} from "../test/harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers: { origin: APP_ORIGIN, ...headers },
  });

describe("register → me → logout", () => {
  it("creates an account, signs in, and signs out", async () => {
    const email = uniqueEmail("flow");
    const registered = await post("/api/auth/register", {
      email: email.toUpperCase(),
      password: "correct horse battery",
      name: "Ana",
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().user).toMatchObject({ email, name: "Ana" });
    const cookie = sessionCookieFrom(registered);

    const me = await h.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: registered.json().user, memberships: [] });

    const logout = await post("/api/auth/logout", undefined, { cookie });
    expect(logout.statusCode).toBe(204);

    const after = await h.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
    expect(after.headers["content-type"]).toContain("application/problem+json");
  });

  it("never returns the password hash, and stores argon2id", async () => {
    const { email } = await registerUser(h.app);

    const login = await post("/api/auth/login", { email, password: "correct horse battery" });
    expect(login.body).not.toContain("argon2");
    const [row] = await h.db.global.select().from(users).where(eq(users.email, email));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("rejects a duplicate email with 409", async () => {
    const { email } = await registerUser(h.app);

    const again = await post("/api/auth/register", {
      email,
      password: "another password",
      name: "Copy",
    });

    expect(again.statusCode).toBe(409);
  });

  it("validates input at the edge with 400", async () => {
    const res = await post("/api/auth/register", { email: "nope", password: "short", name: "" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ type: "about:blank", status: 400 });
  });
});

describe("session cookie", () => {
  it("is HttpOnly, Secure, SameSite=Lax, Path=/ and expires in 14 days", async () => {
    const res = await post("/api/auth/register", {
      email: uniqueEmail("cookie"),
      password: "correct horse battery",
      name: "Ana",
    });

    const cookie = res.cookies.find((c) => c.name === "__Host-waitless_session");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    const expires = cookie?.expires;
    if (!(expires instanceof Date)) throw new Error("session cookie has no expiry");
    const days = (expires.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
  });

  it("stores only a hash of the token", async () => {
    const res = await post("/api/auth/register", {
      email: uniqueEmail("hash"),
      password: "correct horse battery",
      name: "Ana",
    });
    const token = sessionCookieFrom(res).split("=")[1] ?? "";

    const rows = await h.db.global.select({ id: sessions.id }).from(sessions);
    expect(rows.some((r) => r.id === token)).toBe(false);
  });

  it("is renewed when less than half of its lifetime remains", async () => {
    const { cookie, id } = await registerUser(h.app);
    const inThreeDays = new Date(Date.now() + 3 * 86_400_000);
    await h.db.global
      .update(sessions)
      .set({ expiresAt: inThreeDays })
      .where(eq(sessions.userId, id));

    const me = await h.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

    expect(me.statusCode).toBe(200);
    const renewed = me.cookies.find((c) => c.name === "__Host-waitless_session");
    const expires = renewed?.expires;
    if (!(expires instanceof Date)) throw new Error("renewed cookie has no expiry");
    expect(expires.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
  });

  it("is rejected and cleared once expired", async () => {
    const { cookie, id } = await registerUser(h.app);
    await h.db.global
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, id));

    const me = await h.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

    expect(me.statusCode).toBe(401);
    expect(me.headers["set-cookie"]).toContain("__Host-waitless_session=;");
  });
});

describe("login", () => {
  it("issues a fresh session id each time (no session fixation)", async () => {
    const { email, cookie: first } = await registerUser(h.app);

    const login = await post("/api/auth/login", { email, password: "correct horse battery" });

    expect(login.statusCode).toBe(200);
    expect(sessionCookieFrom(login)).not.toBe(first);
  });

  it("gives the same 401 for a wrong password and an unknown email", async () => {
    const { email } = await registerUser(h.app);

    const wrongPassword = await post("/api/auth/login", { email, password: "wrong password" });
    const unknownEmail = await post("/api/auth/login", {
      email: uniqueEmail("ghost"),
      password: "wrong password",
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().detail).toBe(unknownEmail.json().detail);
  });

  it("is rate limited to 5 attempts per minute per IP and email", async () => {
    const email = uniqueEmail("brute");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      statuses.push((await post("/api/auth/login", { email, password: "guess" })).statusCode);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    const sixth = await post("/api/auth/login", { email, password: "guess" });
    expect(sixth.headers["content-type"]).toContain("application/problem+json");
    expect(sixth.headers["retry-after"]).toBeDefined();
  });
});

describe("Origin check (CSRF)", () => {
  it("refuses a state-changing request from another origin", async () => {
    const res = await post(
      "/api/auth/register",
      { email: uniqueEmail(), password: "correct horse battery", name: "Eve" },
      { origin: "https://evil.example" },
    );

    expect(res.statusCode).toBe(403);
  });

  it("refuses a state-changing request without Origin", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/logout",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toBe("Missing Origin header");
  });

  it("lets safe methods through without Origin", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/auth/me" });

    expect(res.statusCode).toBe(401);
  });
});
