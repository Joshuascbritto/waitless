/**
 * Background jobs against real Postgres and Redis, with a fake Notifier
 * (no network): what gets enqueued, what gets sent, dedupe, 410 cleanup,
 * and the auto no-show running through a real BullMQ worker.
 */
import { eq, pushSubscriptions, tickets } from "@waitless/db";
import type { PushMessage } from "@waitless/shared";
import type { Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, type Harness, registerUser, startHarness } from "../test/harness.ts";
import type { DeliveryResult, Notifier, PushTarget } from "./notifier.ts";
import { type ProcessorDeps, processNotifyScan, processSendPush } from "./processors.ts";
import type { SendPushJob } from "./queues.ts";
import { startWorkers } from "./workers.ts";

const TENANT = "jobs-shop";
const log = pino({ level: "silent" });

class FakeNotifier implements Notifier {
  sent: Array<{ target: PushTarget; message: PushMessage }> = [];
  next: DeliveryResult | Error = "delivered";
  async send(target: PushTarget, message: PushMessage): Promise<DeliveryResult> {
    if (this.next instanceof Error) throw this.next;
    this.sent.push({ target, message });
    return this.next;
  }
}

let h: Harness;
let owner: { cookie: string };
let tenantId: string;
let queueCounter = 0;

function deps(notifier: Notifier | null, enqueued: SendPushJob[] = []): ProcessorDeps {
  return {
    db: h.db,
    notifier,
    enqueueSendPush: async (job) => {
      enqueued.push(job);
    },
    publish: async () => {},
    log,
  };
}

const post = (url: string, payload?: object, cookie?: string) =>
  h.app.inject({
    method: "POST",
    url,
    headers: { origin: APP_ORIGIN, ...(cookie ? { cookie } : {}) },
    ...(payload ? { payload } : {}),
  });

async function freshQueue(settings: object = {}) {
  queueCounter += 1;
  const slug = `q-${queueCounter}`;
  const res = await post(
    `/api/admin/${TENANT}/queues`,
    { name: slug, slug, ...settings },
    owner.cookie,
  );
  return { id: res.json().id as string, slug };
}

let subscriptionCounter = 0;
async function joinWithPush(queueSlug: string, name: string) {
  const { token } = (await post(`/api/public/q/${TENANT}/${queueSlug}/tickets`, { name })).json();
  subscriptionCounter += 1;
  const res = await post(`/api/public/q/${TENANT}/t/${token}/push`, {
    endpoint: `https://fcm.googleapis.com/fcm/send/test-${subscriptionCounter}`,
    keys: { p256dh: "p256dh-key", auth: "auth-key" },
  });
  expect(res.statusCode).toBe(204);
  const [row] = await h.db.withTenant(tenantId, (tx) =>
    tx.select().from(tickets).where(eq(tickets.publicToken, token)),
  );
  if (!row) throw new Error("ticket not found");
  return row;
}

const callNext = async (queueId: string) =>
  (await post(`/api/admin/${TENANT}/queues/${queueId}/call-next`, undefined, owner.cookie)).json()
    .ticket as { id: string; calledAt: string };

beforeAll(async () => {
  h = await startHarness();
  owner = await registerUser(h.app);
  const res = await post("/api/tenants", { name: "Jobs Shop", slug: TENANT }, owner.cookie);
  tenantId = res.json().tenant.id;
});

afterAll(async () => {
  await h?.stop();
});

describe("calling a ticket", () => {
  it("enqueues 'your turn' and the delayed no-show, both keyed by this call", async () => {
    const queue = await freshQueue({ noShowAfterMinutes: 5 });
    const ticket = await joinWithPush(queue.slug, "Ana");

    const called = await callNext(queue.id);
    const calledAtMs = new Date(called.calledAt).getTime();

    const push = await h.jobs.notifications.getJob(`push-${ticket.id}-called-${calledAtMs}`);
    expect(push?.data).toEqual({ tenantId, ticketId: ticket.id, kind: "called", calledAtMs });
    const noShow = await h.jobs.timers.getJob(`no-show-${ticket.id}-${calledAtMs}`);
    expect(noShow?.opts.delay).toBe(5 * 60_000);
  });
});

describe("send-push", () => {
  it("sends 'It's your turn!' once, then skips (dedupe)", async () => {
    const queue = await freshQueue();
    const ticket = await joinWithPush(queue.slug, "Bia");
    const called = await callNext(queue.id);
    const job: SendPushJob = {
      tenantId,
      ticketId: ticket.id,
      kind: "called",
      calledAtMs: new Date(called.calledAt).getTime(),
    };
    const notifier = new FakeNotifier();

    expect(await processSendPush(deps(notifier), job)).toBe("sent");
    expect(await processSendPush(deps(notifier), job)).toBe("skipped");

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.message).toMatchObject({
      title: "It's your turn!",
      url: `/q/${TENANT}/t/${ticket.publicToken}`,
    });
  });

  it("deletes a subscription the push service reports as gone (410)", async () => {
    const queue = await freshQueue();
    const ticket = await joinWithPush(queue.slug, "Caio");
    const called = await callNext(queue.id);
    const notifier = new FakeNotifier();
    notifier.next = "gone";

    const outcome = await processSendPush(deps(notifier), {
      tenantId,
      ticketId: ticket.id,
      kind: "called",
      calledAtMs: new Date(called.calledAt).getTime(),
    });

    expect(outcome).toBe("no-subscriptions");
    const left = await h.db.withTenant(tenantId, (tx) =>
      tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.ticketId, ticket.id)),
    );
    expect(left).toHaveLength(0);
  });

  it("throws on a transient failure so BullMQ retries", async () => {
    const queue = await freshQueue();
    const ticket = await joinWithPush(queue.slug, "Davi");
    const called = await callNext(queue.id);
    const notifier = new FakeNotifier();
    notifier.next = new Error("push service 503");

    await expect(
      processSendPush(deps(notifier), {
        tenantId,
        ticketId: ticket.id,
        kind: "called",
        calledAtMs: new Date(called.calledAt).getTime(),
      }),
    ).rejects.toThrow("503");
  });

  it("skips a 'your turn' about an older call", async () => {
    const queue = await freshQueue();
    const ticket = await joinWithPush(queue.slug, "Eva");
    const called = await callNext(queue.id);
    const notifier = new FakeNotifier();

    const outcome = await processSendPush(deps(notifier), {
      tenantId,
      ticketId: ticket.id,
      kind: "called",
      calledAtMs: new Date(called.calledAt).getTime() - 60_000,
    });

    expect(outcome).toBe("skipped");
    expect(notifier.sent).toEqual([]);
  });

  it("skips silently when push isn't configured", async () => {
    expect(await processSendPush(deps(null), { tenantId, ticketId: "x", kind: "almost" })).toBe(
      "skipped",
    );
  });
});

describe("notify-scan", () => {
  it("queues 'almost up' for subscribed customers with at most N ahead, once", async () => {
    const queue = await freshQueue({ notifyWhenAhead: 2 });
    const people = [];
    for (const name of ["P1", "P2", "P3", "P4"]) people.push(await joinWithPush(queue.slug, name));
    const enqueued: SendPushJob[] = [];

    expect(
      await processNotifyScan(deps(new FakeNotifier(), enqueued), { tenantId, queueId: queue.id }),
    ).toBe(3);
    expect(enqueued.map((j) => j.ticketId)).toEqual(people.slice(0, 3).map((p) => p.id));

    // After they are notified, a new scan finds nobody new.
    const notifier = new FakeNotifier();
    for (const job of enqueued) await processSendPush(deps(notifier), job);
    expect(notifier.sent[0]?.message.title).toBe("You're almost up at Jobs Shop");
    expect(await processNotifyScan(deps(notifier, []), { tenantId, queueId: queue.id })).toBe(0);
  });
});

describe("worker (real BullMQ)", () => {
  let workers: Worker[] = [];
  const connections: Redis[] = [];

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    for (const c of connections) c.disconnect();
  });

  it("runs the delayed auto no-show and announces the change", async () => {
    const published: string[] = [];
    workers = startWorkers(
      {
        ...deps(new FakeNotifier()),
        publish: async (event) => void published.push(event.ticketId ?? ""),
      },
      () => {
        const connection = new Redis(h.redisUrl, { maxRetriesPerRequest: null });
        connections.push(connection);
        return connection;
      },
    );
    const queue = await freshQueue();
    await post(`/api/public/q/${TENANT}/${queue.slug}/tickets`, { name: "Fábio" });
    const called = await callNext(queue.id);

    // The API already scheduled this call's no-show (5 min). Re-scheduling with the
    // same id is ignored (that's the dedupe), so shorten the real job's delay instead.
    const job = await h.jobs.timers.getJob(
      `no-show-${called.id}-${new Date(called.calledAt).getTime()}`,
    );
    expect(job).toBeDefined();
    await job?.changeDelay(50);

    let status = "called";
    for (let i = 0; i < 100 && status === "called"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const [row] = await h.db.withTenant(tenantId, (tx) =>
        tx.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, called.id)),
      );
      status = row?.status ?? "missing";
    }
    expect(status).toBe("no_show");
    expect(published).toContain(called.id);
  });
});
