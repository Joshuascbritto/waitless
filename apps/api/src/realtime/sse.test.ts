import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { listen, openStream } from "../test/sse-client.ts";
import { formatSseEvent, SseConnection, SseRegistry } from "./sse.ts";

describe("formatSseEvent", () => {
  it("writes one event with JSON data and a blank line", () => {
    expect(formatSseEvent("ticket", { status: "called", note: "line\nbreak" })).toBe(
      'event: ticket\ndata: {"status":"called","note":"line\\nbreak"}\n\n',
    );
  });
});

describe("SseConnection", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function serve(heartbeatMs: number) {
    const registry = new SseRegistry();
    app = Fastify();
    app.addHook("preClose", async () => registry.closeAll());
    app.get("/stream", async (request, reply) => {
      const slot = registry.reserve(request.ip);
      const stream = new SseConnection(request, reply, heartbeatMs);
      if (slot) registry.add(stream, slot);
      stream.send("hello", { ok: true });
      return reply;
    });
    return { url: await listen(app), registry };
  }

  it("sends retry, events and heartbeats", async () => {
    const { url } = await serve(30);
    const stream = await openStream(`${url}/stream`);
    try {
      expect(await stream.next("hello")).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await stream.next("never", 50).catch(() => undefined); // pull pending chunks
      expect(stream.raw()).toContain("retry: 3000");
      expect(stream.raw()).toContain(": ping");
    } finally {
      stream.close();
    }
  });

  it("counts connections per IP and forgets them on disconnect", async () => {
    const { url, registry } = await serve(1_000);
    const stream = await openStream(`${url}/stream`);
    await stream.next("hello");
    expect(registry.size).toBe(1);
    expect(registry.connectionsFrom("127.0.0.1")).toBe(1);

    stream.close();
    for (let i = 0; i < 40 && registry.size > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(registry.size).toBe(0);
    expect(registry.connectionsFrom("127.0.0.1")).toBe(0);
  });

  it("lets the server shut down while streams are open", async () => {
    const { url } = await serve(1_000);
    const stream = await openStream(`${url}/stream`);
    await stream.next("hello");

    const closing = app?.close();
    app = undefined;
    await expect(closing).resolves.toBeUndefined();
  });
});

describe("SseRegistry.reserve", () => {
  it("enforces the per-IP cap synchronously, before any await", () => {
    const registry = new SseRegistry();

    // Three "concurrent" requests reserving back to back, as they would before awaiting lookups.
    const slots = [1, 2, 3].map(() => registry.reserve("10.0.0.1", 2));

    expect(slots.filter(Boolean)).toHaveLength(2);
    expect(slots[2]).toBeUndefined();
    expect(registry.reserve("10.0.0.2", 2)).toBeDefined();
  });

  it("frees the slot on release, exactly once", () => {
    const registry = new SseRegistry();
    const slot = registry.reserve("10.0.0.1", 1);

    slot?.release();
    slot?.release();

    expect(registry.connectionsFrom("10.0.0.1")).toBe(0);
    expect(registry.reserve("10.0.0.1", 1)).toBeDefined();
    expect(registry.reserve("10.0.0.1", 1)).toBeUndefined();
  });
});
