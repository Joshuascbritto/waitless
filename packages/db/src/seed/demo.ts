/**
 * Demo data (SPEC §13): two fictional businesses, two users, 30 days of
 * history and a few tickets live right now. Every tenant-scoped write runs
 * inside withTenant(), like the app's: the seed doesn't bypass RLS either.
 */
import { randomBytes } from "node:crypto";
import { formatDisplayCode } from "@waitless/shared";
import { inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "../client.ts";
import {
  memberships,
  queueCounters,
  queues,
  tenants,
  ticketEvents,
  tickets,
  users,
} from "../schema.ts";
import { createTenantWithOwner } from "../tenants.ts";
import {
  type ArrivalProfile,
  fakeCustomerName,
  type SimulatedQueue,
  simulateHistory,
} from "./generate.ts";
import { seededRandom } from "./random.ts";
import { localDayOf } from "./time.ts";

export const DEMO_HISTORY_DAYS = 30;

export const DEMO_USERS = {
  owner: { email: "owner@demo.waitless.dev", name: "Demo Owner" },
  staff: { email: "staff@demo.waitless.dev", name: "Demo Staff" },
} as const;

/** A ticket on the board right now, `*Ago` in minutes before the seed runs. */
interface LiveTicket {
  status: "waiting" | "serving";
  joinedAgo: number;
  calledAgo?: number;
  servingAgo?: number;
}

interface DemoQueue extends SimulatedQueue {
  name: string;
  slug: string;
  prefix: string;
  profile: ArrivalProfile;
  live: LiveTicket[];
}

interface DemoTenant {
  name: string;
  slug: string;
  timezone: string;
  /** Staff user is a member here too (the owner owns every demo tenant). */
  withStaff: boolean;
  queues: DemoQueue[];
}

const MON_TO_FRI_9_19 = { 1: [9, 19], 2: [9, 19], 3: [9, 19], 4: [9, 19], 5: [9, 19] } as const;

/** Busy Friday evenings and Saturday mornings; quiet Mondays and lunch. */
function barbershopRush(weekday: number, hour: number): number {
  if (weekday === 5 && hour >= 17) return 2.2;
  if (weekday === 6 && hour < 12) return 2.4;
  if (weekday === 6) return 1.4;
  if (hour === 12) return 0.6;
  return weekday === 1 ? 0.7 : 1;
}

const BARBERSHOP_HOURS = { ...MON_TO_FRI_9_19, 6: [9, 17], 7: null } as const;

export const DEMO_TENANTS: readonly DemoTenant[] = [
  {
    name: "Barbearia Demo",
    slug: "barbearia-demo",
    timezone: "America/Bahia",
    withStaff: true,
    queues: [
      {
        name: "Haircut",
        slug: "haircut",
        prefix: "A",
        activeServers: 2,
        defaultServiceMinutes: 20,
        noShowAfterMinutes: 5,
        profile: { hours: BARBERSHOP_HOURS, baseRate: 2.5, multiplier: barbershopRush },
        live: [
          { status: "serving", joinedAgo: 41, calledAgo: 14, servingAgo: 13 },
          { status: "serving", joinedAgo: 33, calledAgo: 6, servingAgo: 5 },
          { status: "waiting", joinedAgo: 24 },
          { status: "waiting", joinedAgo: 17 },
          { status: "waiting", joinedAgo: 9 },
          { status: "waiting", joinedAgo: 3 },
        ],
      },
      {
        name: "Beard",
        slug: "beard",
        prefix: "B",
        activeServers: 1,
        defaultServiceMinutes: 10,
        noShowAfterMinutes: 5,
        profile: { hours: BARBERSHOP_HOURS, baseRate: 1.2, multiplier: barbershopRush },
        live: [
          { status: "serving", joinedAgo: 12, calledAgo: 4, servingAgo: 3 },
          { status: "waiting", joinedAgo: 7 },
        ],
      },
    ],
  },
  {
    name: "PetShop Demo",
    slug: "petshop-demo",
    timezone: "America/Bahia",
    withStaff: false,
    queues: [
      {
        name: "Bath & grooming",
        slug: "bath-grooming",
        prefix: "P",
        activeServers: 2,
        defaultServiceMinutes: 30,
        noShowAfterMinutes: 10,
        profile: {
          hours: {
            1: [8, 18],
            2: [8, 18],
            3: [8, 18],
            4: [8, 18],
            5: [8, 18],
            6: [8, 14],
            7: null,
          },
          baseRate: 1.5,
          // Saturday morning baths, a Monday catch-up after the weekend, quiet lunch.
          multiplier: (weekday, hour) =>
            weekday === 6 ? 2.2 : hour === 12 ? 0.5 : weekday === 1 ? 1.2 : 1,
        },
        live: [
          { status: "serving", joinedAgo: 52, calledAgo: 21, servingAgo: 20 },
          { status: "waiting", joinedAgo: 28 },
          { status: "waiting", joinedAgo: 8 },
        ],
      },
    ],
  },
];

export class DemoAlreadySeededError extends Error {
  constructor() {
    super("Demo data already exists. Run the seed with --reset-demo to replace it.");
    this.name = "DemoAlreadySeededError";
  }
}

export interface SeedDemoOptions {
  /** Hash of the demo password, computed by the caller (the API owns password hashing). */
  passwordHash: string;
  /** Delete the demo tenants and users first (nightly demo reset). */
  reset?: boolean;
  now?: Date;
  /** Same seed, same history. */
  seed?: number;
}

export interface SeedDemoResult {
  tenants: number;
  tickets: number;
}

/** A row ready to insert, history or live. */
interface SeedTicket {
  day: string;
  number: number;
  customerName: string;
  source: "qr" | "walk_in";
  status: "waiting" | "serving" | "done" | "cancelled" | "no_show";
  joinedAt: Date;
  calledAt: Date | null;
  servingAt: Date | null;
  finishedAt: Date | null;
}

export async function seedDemo(db: Db, options: SeedDemoOptions): Promise<SeedDemoResult> {
  const now = options.now ?? new Date();
  const random = seededRandom(options.seed ?? 20_260_301);
  const slugs = DEMO_TENANTS.map((t) => t.slug);
  const emails = [DEMO_USERS.owner.email, DEMO_USERS.staff.email];

  if (options.reset) {
    // Global tables. Deleting a tenant cascades to its queues, tickets and
    // events: foreign key actions aren't subject to RLS.
    await db.global.delete(tenants).where(inArray(tenants.slug, slugs));
    await db.global.delete(users).where(inArray(users.email, emails));
  } else {
    const existing = await db.global
      .select({ id: tenants.id })
      .from(tenants)
      .where(inArray(tenants.slug, slugs));
    if (existing.length > 0) throw new DemoAlreadySeededError();
  }

  const [owner, staff] = await db.global
    .insert(users)
    .values([
      { ...DEMO_USERS.owner, passwordHash: options.passwordHash },
      { ...DEMO_USERS.staff, passwordHash: options.passwordHash },
    ])
    .returning({ id: users.id });
  if (!owner || !staff) throw new Error("demo user insert returned no rows");

  let ticketCount = 0;
  for (const demo of DEMO_TENANTS) {
    const tenant = await createTenantWithOwner(
      db,
      { name: demo.name, slug: demo.slug, timezone: demo.timezone },
      owner.id,
    );
    const staffIds = demo.withStaff ? [owner.id, staff.id] : [owner.id];

    ticketCount += await db.withTenant(tenant.id, async (tx) => {
      if (demo.withStaff) {
        await tx
          .insert(memberships)
          .values({ tenantId: tenant.id, userId: staff.id, role: "staff" });
      }
      let inserted = 0;
      for (const config of demo.queues) {
        const [queue] = await tx
          .insert(queues)
          .values({
            tenantId: tenant.id,
            name: config.name,
            slug: config.slug,
            prefix: config.prefix,
            activeServers: config.activeServers,
            defaultServiceMinutes: config.defaultServiceMinutes,
            noShowAfterMinutes: config.noShowAfterMinutes,
          })
          .returning();
        if (!queue) throw new Error("demo queue insert returned no row");

        const today = localDayOf(now, demo.timezone);
        const history: SeedTicket[] = simulateHistory({
          queue: config,
          profile: config.profile,
          timezone: demo.timezone,
          today,
          days: DEMO_HISTORY_DAYS,
          now,
          random,
        });
        const live = liveTickets(config.live, history, today, now, random);
        const rows = [...history, ...live];

        await insertTickets(tx, {
          tenantId: tenant.id,
          queueId: queue.id,
          prefix: config.prefix,
          staffIds,
          rows,
          random,
        });
        await setCounters(tx, tenant.id, queue.id, rows);
        inserted += rows.length;
      }
      return inserted;
    });
  }

  return { tenants: DEMO_TENANTS.length, tickets: ticketCount };
}

function liveTickets(
  specs: readonly LiveTicket[],
  history: readonly SeedTicket[],
  today: string,
  now: Date,
  random: () => number,
): SeedTicket[] {
  const ago = (minutes: number | undefined) =>
    minutes === undefined ? null : new Date(now.getTime() - minutes * 60_000);
  let number = history.filter((t) => t.day === today).length;
  return [...specs]
    .sort((a, b) => b.joinedAgo - a.joinedAgo)
    .map((spec) => {
      number += 1;
      const joinedAt = ago(spec.joinedAgo) ?? now;
      return {
        // Numbered on today's counter even if "joinedAgo" crosses midnight: it's a demo.
        day: today,
        number,
        customerName: fakeCustomerName(random),
        source: "qr",
        status: spec.status,
        joinedAt,
        calledAt: ago(spec.calledAgo),
        servingAt: ago(spec.servingAgo),
        finishedAt: null,
      };
    });
}

const BATCH = 500;

/** Tickets plus the events the app would have logged for them. */
async function insertTickets(
  tx: Tx,
  input: {
    tenantId: string;
    queueId: string;
    prefix: string;
    staffIds: readonly string[];
    rows: readonly SeedTicket[];
    random: () => number;
  },
): Promise<void> {
  const { tenantId, queueId } = input;
  for (let start = 0; start < input.rows.length; start += BATCH) {
    const batch = input.rows.slice(start, start + BATCH).map((row) => ({
      row,
      token: randomBytes(16).toString("base64url"),
      staffId: input.staffIds[Math.floor(input.random() * input.staffIds.length)] ?? null,
    }));

    const inserted = await tx
      .insert(tickets)
      .values(
        batch.map(({ row, token, staffId }) => ({
          tenantId,
          queueId,
          publicToken: token,
          number: row.number,
          displayCode: formatDisplayCode(input.prefix, row.number),
          customerName: row.customerName,
          source: row.source,
          status: row.status,
          sortKey: String(row.joinedAt.getTime()),
          joinedAt: row.joinedAt,
          calledAt: row.calledAt,
          servingAt: row.servingAt,
          finishedAt: row.finishedAt,
          calledBy: row.calledAt ? staffId : null,
        })),
      )
      .returning({ id: tickets.id, publicToken: tickets.publicToken });
    const idByToken = new Map(inserted.map((t) => [t.publicToken, t.id]));

    const events: (typeof ticketEvents.$inferInsert)[] = [];
    for (const { row, token, staffId } of batch) {
      const ticketId = idByToken.get(token);
      if (!ticketId) throw new Error("seeded ticket id not found");
      const base = { tenantId, queueId, ticketId };
      const staff = { actorType: "staff", actorId: staffId } as const;

      events.push({
        ...base,
        type: "joined",
        actorType: row.source === "walk_in" ? "staff" : "customer",
        actorId: row.source === "walk_in" ? staffId : null,
        payload: { source: row.source },
        at: row.joinedAt,
      });
      if (row.calledAt) events.push({ ...base, ...staff, type: "called", at: row.calledAt });
      if (row.servingAt) events.push({ ...base, ...staff, type: "serving", at: row.servingAt });
      if (row.finishedAt) {
        if (row.status === "done") {
          events.push({ ...base, ...staff, type: "done", at: row.finishedAt });
        } else if (row.status === "cancelled") {
          events.push({ ...base, type: "cancelled", actorType: "customer", at: row.finishedAt });
        } else if (row.status === "no_show") {
          events.push({ ...base, type: "no_show", actorType: "system", at: row.finishedAt });
        }
      }
    }
    for (let e = 0; e < events.length; e += BATCH) {
      await tx.insert(ticketEvents).values(events.slice(e, e + BATCH));
    }
  }
}

/** Daily counters at the highest number used, so the next real join continues the sequence. */
async function setCounters(
  tx: Tx,
  tenantId: string,
  queueId: string,
  rows: readonly SeedTicket[],
): Promise<void> {
  const last = new Map<string, number>();
  for (const row of rows) last.set(row.day, Math.max(last.get(row.day) ?? 0, row.number));
  if (last.size === 0) return;
  await tx
    .insert(queueCounters)
    .values([...last].map(([day, lastNumber]) => ({ tenantId, queueId, day, lastNumber })))
    .onConflictDoUpdate({
      target: [queueCounters.queueId, queueCounters.day],
      set: { lastNumber: sql`excluded.last_number` },
    });
}
