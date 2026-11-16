/**
 * Real-time, end to end over real HTTP, Postgres and Redis.
 * Includes the mandatory cross-instance fan-out test (SPEC §12.4).
 */
import type { Board, PublicTicketViewResponse } from "@waitless/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, type Harness, registerUser, startHarness } from "../test/harness.ts";
import { listen, openStream } from "../test/sse-client.ts";
import { channelFor } from "./queue-events.ts";

const TENANT = "fan-out-shop";

let h: Harness;
let instanceA: FastifyInstance;
let urlB: string;
let owner: { cookie: string };
let queueId: string;
let queueSlug: string;

let queueCounter = 0;
/** A fresh queue per test keeps events from earlier tests out of the way. */
async function freshQueue(): Promise<void> {
  queueCounter += 1;
  queueSlug = `queue-${queueCounter}`;
  const res = await instanceA.inject({
    method: "POST",
    url: `/api/admin/${TENANT}/queues`,
    headers: { origin: APP_ORIGIN, cookie: owner.cookie },
    payload: { name: `Queue ${queueCounter}`, slug: queueSlug },
  });
  queueId = res.json().id;
}

async function join(name: string): Promise<string> {
  const res = await instanceA.inject({
    method: "POST",
    url: `/api/public/q/${TENANT}/${queueSlug}/tickets`,
    headers: { origin: APP_ORIGIN },
    payload: { name },
  });
  return res.json().token;
}

const staffPost = (path: string, payload?: object) =>
  instanceA.inject({
    method: "POST",
    url: `/api/admin/${TENANT}${path}`,
    headers: { origin: APP_ORIGIN, cookie: owner.cookie },
    ...(payload ? { payload } : {}),
  });

async function numsub(): Promise<number> {
  const [, count] = (await h.redis.pubsub("NUMSUB", channelFor(queueId))) as [string, number];
  return count;
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  h = await startHarness();
  instanceA = h.app;
  // Instance B: a second "replica" with its own Redis subscriber, on a real port.
  urlB = await listen(await h.startInstance());

  owner = await registerUser(instanceA);
  await instanceA.inject({
    method: "POST",
    url: "/api/tenants",
    headers: { origin: APP_ORIGIN, cookie: owner.cookie },
    payload: { name: "Fan-out Shop", slug: TENANT },
  });
});

afterAll(async () => {
  await h?.stop();
});

describe("cross-instance fan-out (SPEC §12.4)", () => {
  it("a customer streaming from instance B sees 'call next' done on instance A", async () => {
    await freshQueue();
    const token = await join("Ana");
    const stream = await openStream(`${urlB}/api/public/q/${TENANT}/t/${token}/stream`);
    try {
      expect(stream.status).toBe(200);
      const first = await stream.next<PublicTicketViewResponse>("ticket");
      expect(first).toMatchObject({ status: "waiting", position: 1 });

      const called = await staffPost(`/queues/${queueId}/call-next`);
      expect(called.statusCode).toBe(200);

      const update = await stream.next<PublicTicketViewResponse>("ticket");
      expect(update.status).toBe("called");
    } finally {
      stream.close();
    }
  });

  it("a staff board streaming from B gets the whole board after a walk-in on A", async () => {
    await freshQueue();
    const stream = await openStream(`${urlB}/api/admin/${TENANT}/queues/${queueId}/stream`, {
      cookie: owner.cookie,
    });
    try {
      expect((await stream.next<Board>("board")).waiting).toEqual([]);

      await staffPost(`/queues/${queueId}/walk-ins`, { name: "Seu Jorge" });

      const board = await stream.next<Board>("board");
      expect(board.waiting.map((t) => t.customerName)).toEqual(["Seu Jorge"]);
    } finally {
      stream.close();
    }
  });

  it("other customers' positions move when someone ahead leaves", async () => {
    await freshQueue();
    const first = await join("Ana");
    const second = await join("Bia");
    const stream = await openStream(`${urlB}/api/public/q/${TENANT}/t/${second}/stream`);
    try {
      expect((await stream.next<PublicTicketViewResponse>("ticket")).position).toBe(2);

      await instanceA.inject({
        method: "DELETE",
        url: `/api/public/q/${TENANT}/t/${first}`,
        headers: { origin: APP_ORIGIN },
      });

      expect((await stream.next<PublicTicketViewResponse>("ticket")).position).toBe(1);
    } finally {
      stream.close();
    }
  });
});

describe("subscriptions", () => {
  it("holds one Redis subscription per queue per instance, released with the last client", async () => {
    await freshQueue();
    const tokens = [await join("Ana"), await join("Bia")];
    const streams = await Promise.all(
      tokens.map((t) => openStream(`${urlB}/api/public/q/${TENANT}/t/${t}/stream`)),
    );
    await Promise.all(streams.map((s) => s.next("ticket")));

    expect(await numsub()).toBe(1);

    for (const s of streams) s.close();
    await eventually(async () => (await numsub()) === 0);
  });
});

describe("stream payloads and access", () => {
  it("customer events never carry other customers' names or tokens", async () => {
    await freshQueue();
    const other = await join("Private Person");
    const mine = await join("Me");
    const stream = await openStream(`${urlB}/api/public/q/${TENANT}/t/${mine}/stream`);
    try {
      await stream.next("ticket");
      await staffPost(`/queues/${queueId}/call-next`);
      await stream.next("ticket");

      expect(stream.raw()).not.toContain("Private Person");
      expect(stream.raw()).not.toContain(other);
    } finally {
      stream.close();
    }
  });

  it("answers 404 (not a stream) for an unknown ticket", async () => {
    const res = await instanceA.inject({
      method: "GET",
      url: `/api/public/q/${TENANT}/t/does-not-exist/stream`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("refuses the board stream to non-members", async () => {
    await freshQueue();
    const outsider = await registerUser(instanceA);

    const res = await instanceA.inject({
      method: "GET",
      url: `/api/admin/${TENANT}/queues/${queueId}/stream`,
      headers: { cookie: outsider.cookie },
    });

    expect(res.statusCode).toBe(404);
  });

  it("sends SSE headers that keep proxies from buffering", async () => {
    await freshQueue();
    const token = await join("Ana");
    const response = await fetch(`${urlB}/api/public/q/${TENANT}/t/${token}/stream`);
    try {
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(response.headers.get("cache-control")).toContain("no-cache");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(response.headers.get("x-request-id")).toBeTruthy();
    } finally {
      await response.body?.cancel();
    }
  });
});
