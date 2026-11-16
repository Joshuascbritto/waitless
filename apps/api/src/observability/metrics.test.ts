import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, type Harness, registerUser, startHarness } from "../test/harness.ts";
import { createApiMetrics, startMetricsServer } from "./metrics.ts";

describe("startMetricsServer", () => {
  it("serves the registry at GET /metrics and nothing else", async () => {
    const metrics = createApiMetrics();
    metrics.ticketsCreated.inc({ source: "qr" });
    const server = await startMetricsServer(metrics.registry, { host: "127.0.0.1", port: 0 });
    const { port } = server.address() as AddressInfo;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("text/plain");
      expect(await ok.text()).toContain('waitless_tickets_created_total{source="qr"} 1');

      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: "POST" })).status).toBe(
        404,
      );
    } finally {
      server.close();
    }
  });
});

describe("API metrics", () => {
  let h: Harness;
  let cookie: string;
  let queueId: string;

  const post = (url: string, payload?: object, withCookie = true) =>
    h.app.inject({
      method: "POST",
      url,
      headers: { origin: APP_ORIGIN, ...(withCookie ? { cookie } : {}) },
      ...(payload ? { payload } : {}),
    });

  beforeAll(async () => {
    h = await startHarness();
    cookie = (await registerUser(h.app)).cookie;
    await post("/api/tenants", { name: "Shop", slug: "shop" });
    queueId = (await post("/api/admin/shop/queues", { name: "Haircut", slug: "haircut" })).json()
      .id;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("count created tickets by source and time call-next by outcome", async () => {
    expect(
      (await post("/api/public/q/shop/haircut/tickets", { name: "Ana" }, false)).statusCode,
    ).toBe(201);
    expect(
      (await post(`/api/admin/shop/queues/${queueId}/walk-ins`, { name: "Bia" })).statusCode,
    ).toBe(201);
    await post(`/api/admin/shop/queues/${queueId}/call-next`);
    await post(`/api/admin/shop/queues/${queueId}/call-next`);
    await post(`/api/admin/shop/queues/${queueId}/call-next`); // empty now

    const text = await h.app.metrics.registry.metrics();
    expect(text).toContain('waitless_tickets_created_total{source="qr"} 1');
    expect(text).toContain('waitless_tickets_created_total{source="walk_in"} 1');
    expect(text).toContain('waitless_call_next_duration_seconds_count{outcome="called"} 2');
    expect(text).toContain('waitless_call_next_duration_seconds_count{outcome="empty"} 1');
    expect(text).toContain("waitless_sse_connections 0");
  });
});
