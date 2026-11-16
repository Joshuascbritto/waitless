/** Joining rules: device cookie, one active ticket per device, rate limits; push subscription. */
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  type Harness,
  registerUser,
  startHarness,
  TEST_VAPID_PUBLIC_KEY,
} from "../test/harness.ts";
import { DEVICE_COOKIE } from "./public.ts";

const TENANT = "join-shop";
let h: Harness;
let owner: { cookie: string };
let queueCounter = 0;

const post = (url: string, payload: object, cookie?: string) =>
  h.app.inject({
    method: "POST",
    url,
    headers: { origin: APP_ORIGIN, ...(cookie ? { cookie } : {}) },
    payload,
  });

function deviceCookie(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === DEVICE_COOKIE);
  if (!cookie) throw new Error("no device cookie");
  return `${cookie.name}=${cookie.value}`;
}

async function freshQueue(): Promise<string> {
  queueCounter += 1;
  const slug = `queue-${queueCounter}`;
  await post(`/api/admin/${TENANT}/queues`, { name: slug, slug }, owner.cookie);
  return slug;
}

const join = (slug: string, name: string, cookie?: string) =>
  post(`/api/public/q/${TENANT}/${slug}/tickets`, { name }, cookie);

beforeAll(async () => {
  h = await startHarness();
  owner = await registerUser(h.app);
  await post("/api/tenants", { name: "Join Shop", slug: TENANT }, owner.cookie);
});

afterAll(async () => {
  await h?.stop();
});

describe("device cookie", () => {
  it("is set on the first public request: HttpOnly, Secure, Lax, one year", async () => {
    const slug = await freshQueue();
    const res = await h.app.inject({ method: "GET", url: `/api/public/q/${TENANT}/${slug}` });

    const cookie = res.cookies.find((c) => c.name === DEVICE_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(cookie?.maxAge).toBe(365 * 86_400);
  });
});

describe("one active ticket per device per queue", () => {
  it("returns the same ticket (200) when the same device joins again", async () => {
    const slug = await freshQueue();
    const first = await join(slug, "Ana");
    const cookie = deviceCookie(first);

    const again = await join(slug, "Ana again", cookie);

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().token).toBe(first.json().token);
  });

  it("hands both of two simultaneous taps the same ticket", async () => {
    const slug = await freshQueue();
    const cookie = deviceCookie(
      await h.app.inject({ method: "GET", url: `/api/public/q/${TENANT}/${slug}` }),
    );

    const [a, b] = await Promise.all([join(slug, "Bia", cookie), join(slug, "Bia", cookie)]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().token).toBe(b.json().token);
  });

  it("lets the device join again once its ticket is over", async () => {
    const slug = await freshQueue();
    const first = await join(slug, "Caio");
    const cookie = deviceCookie(first);
    await h.app.inject({
      method: "DELETE",
      url: `/api/public/q/${TENANT}/t/${first.json().token}`,
      headers: { origin: APP_ORIGIN },
    });

    const again = await join(slug, "Caio", cookie);

    expect(again.statusCode).toBe(201);
    expect(again.json().token).not.toBe(first.json().token);
  });

  it("allows different devices in the same queue", async () => {
    const slug = await freshQueue();

    const [a, b] = await Promise.all([join(slug, "Davi"), join(slug, "Eva")]);

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().token).not.toBe(b.json().token);
  });
});

describe("join rate limit", () => {
  it("allows 3 joins per device per queue in 10 minutes", async () => {
    const slug = await freshQueue();
    const cookie = deviceCookie(await join(slug, "Fábio"));

    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const r = await join(slug, "Fábio", cookie);
      statuses.push(r.statusCode);
    }

    // 1st (above) + 2 more are let through (existing ticket → 200); the 4th is refused.
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe("join rate limit per IP (backstop)", () => {
  it("allows 30 different devices from one IP, then refuses with Retry-After", async () => {
    const slug = await freshQueue();

    // No cookie on each request: every one is a new device, all from 127.0.0.1.
    const statuses = [];
    for (let i = 0; i < 30; i++) statuses.push((await join(slug, `Guest ${i}`)).statusCode);
    const blocked = await join(slug, "One too many");

    expect(statuses.every((status) => status === 201)).toBe(true);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.headers["content-type"]).toContain("application/problem+json");
  });
});

describe("push subscription", () => {
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: "BNcR...", auth: "tBHI..." },
  };

  it("publishes the VAPID public key", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/public/push/key" });

    expect(res.json()).toEqual({ publicKey: TEST_VAPID_PUBLIC_KEY });
  });

  it("saves a subscription for an active ticket", async () => {
    const slug = await freshQueue();
    const { token } = (await join(slug, "Gil")).json();

    const res = await post(`/api/public/q/${TENANT}/t/${token}/push`, subscription);

    expect(res.statusCode).toBe(204);
  });

  it("refuses a finished ticket and a non-HTTPS endpoint", async () => {
    const slug = await freshQueue();
    const { token } = (await join(slug, "Hugo")).json();
    const bad = await post(`/api/public/q/${TENANT}/t/${token}/push`, {
      ...subscription,
      endpoint: "http://evil.example/collect",
    });
    await h.app.inject({
      method: "DELETE",
      url: `/api/public/q/${TENANT}/t/${token}`,
      headers: { origin: APP_ORIGIN },
    });
    const finished = await post(`/api/public/q/${TENANT}/t/${token}/push`, subscription);

    expect(bad.statusCode).toBe(400);
    expect(finished.statusCode).toBe(409);
  });
});
