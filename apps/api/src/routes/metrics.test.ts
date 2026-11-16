/** GET /api/admin/:tenantSlug/metrics: access control and contract. The SQL itself is tested in @waitless/db. */
import { MetricsSchema } from "@waitless/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, type Harness, registerUser, startHarness } from "../test/harness.ts";

let h: Harness;
let owner: { cookie: string; id: string };
let outsider: { cookie: string; id: string };
let queueId: string;
let otherQueueId: string;

function get(url: string, cookie?: string) {
  return h.app.inject({
    method: "GET",
    url,
    headers: { origin: APP_ORIGIN, ...(cookie ? { cookie } : {}) },
  });
}

async function post(url: string, cookie: string, payload: object) {
  const res = await h.app.inject({
    method: "POST",
    url,
    headers: { origin: APP_ORIGIN, cookie },
    payload,
  });
  expect(res.statusCode).toBeLessThan(300);
  return res.json();
}

beforeAll(async () => {
  h = await startHarness();
  owner = await registerUser(h.app);
  outsider = await registerUser(h.app);

  await post("/api/tenants", owner.cookie, { name: "Barbearia", slug: "barbearia" });
  queueId = (
    await post("/api/admin/barbearia/queues", owner.cookie, { name: "Haircut", slug: "haircut" })
  ).id;
  await post("/api/public/q/barbearia/haircut/tickets", owner.cookie, { name: "Ana" });

  await post("/api/tenants", outsider.cookie, { name: "Other", slug: "other-shop" });
  otherQueueId = (
    await post("/api/admin/other-shop/queues", outsider.cookie, { name: "Other", slug: "other" })
  ).id;
});

afterAll(async () => {
  await h?.stop();
});

describe("GET /metrics", () => {
  it("returns the tenant's metrics for a member", async () => {
    const res = await get("/api/admin/barbearia/metrics?range=30d", owner.cookie);

    expect(res.statusCode).toBe(200);
    const metrics = MetricsSchema.parse(res.json());
    expect(metrics.range).toBe("30d");
    expect(metrics.timezone).toBe("America/Bahia");
    expect(metrics.daily).toHaveLength(30);
    expect(metrics.summary.joined).toBe(1);
  });

  it("defaults to 7 days and narrows to one queue", async () => {
    const res = await get(`/api/admin/barbearia/metrics?queueId=${queueId}`, owner.cookie);

    expect(res.statusCode).toBe(200);
    expect(res.json().daily).toHaveLength(7);
    expect(res.json().summary.joined).toBe(1);
  });

  it("rejects an unknown range", async () => {
    const res = await get("/api/admin/barbearia/metrics?range=1y", owner.cookie);
    expect(res.statusCode).toBe(400);
  });

  it("404s on another tenant's queue id", async () => {
    const res = await get(`/api/admin/barbearia/metrics?queueId=${otherQueueId}`, owner.cookie);
    expect(res.statusCode).toBe(404);
  });

  it("is members only", async () => {
    expect((await get("/api/admin/barbearia/metrics")).statusCode).toBe(401);
    expect((await get("/api/admin/barbearia/metrics", outsider.cookie)).statusCode).toBe(404);
  });
});
