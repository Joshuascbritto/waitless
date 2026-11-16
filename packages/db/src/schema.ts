/**
 * Database schema (SPEC §5). drizzle-kit generates the table migration from
 * this file; row-level security lives in a hand-written SQL migration.
 *
 * Tenant consistency: child tables reference their parent through a composite
 * foreign key (tenant_id, parent_id). RLS stops a tenant from *reading* another
 * tenant's rows, but foreign key checks bypass RLS, so without the composite key
 * a ticket of tenant A could point at a queue of tenant B if its id leaked.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Case-insensitive text (extension created in migration 0000). */
const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });

// --- Global tables (no RLS) -------------------------------------------------

/** Resolved by slug before any tenant context exists. */
export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("America/Bahia"),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: citext("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 (hex) of the session token. The token itself only exists in the cookie. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

// --- Tenant-scoped tables (RLS) ---------------------------------------------

/** Dual-key RLS policy: visible by tenant OR by user (SPEC §9). */
export const memberships = pgTable(
  "memberships",
  {
    tenantId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index("memberships_user_id_idx").on(t.userId),
    check("memberships_role_check", sql`${t.role} in ('owner', 'staff')`),
  ],
);

export const queues = pgTable(
  "queues",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    prefix: char("prefix", { length: 1 }).notNull().default("A"),
    isOpen: boolean("is_open").notNull().default(true),
    activeServers: integer("active_servers").notNull().default(1),
    defaultServiceMinutes: integer("default_service_minutes").notNull().default(15),
    notifyWhenAhead: integer("notify_when_ahead").notNull().default(2),
    noShowAfterMinutes: integer("no_show_after_minutes").notNull().default(5),
    createdAt: createdAt(),
  },
  (t) => [
    unique("queues_tenant_id_slug_key").on(t.tenantId, t.slug),
    unique("queues_tenant_id_id_key").on(t.tenantId, t.id),
    check("queues_active_servers_check", sql`${t.activeServers} > 0`),
    check("queues_default_service_minutes_check", sql`${t.defaultServiceMinutes} > 0`),
    check("queues_notify_when_ahead_check", sql`${t.notifyWhenAhead} >= 0`),
    check("queues_no_show_after_minutes_check", sql`${t.noShowAfterMinutes} > 0`),
  ],
);

/** Daily ticket numbering per queue, in the tenant's timezone (SPEC §6.2). */
export const queueCounters = pgTable(
  "queue_counters",
  {
    tenantId: uuid("tenant_id").notNull(),
    queueId: uuid("queue_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    lastNumber: integer("last_number").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.queueId, t.day] }),
    foreignKey({
      name: "queue_counters_queue_fk",
      columns: [t.tenantId, t.queueId],
      foreignColumns: [queues.tenantId, queues.id],
    }).onDelete("cascade"),
  ],
);

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull(),
    queueId: uuid("queue_id").notNull(),
    /** The customer's capability: random 128-bit, base64url. */
    publicToken: text("public_token").notNull().unique(),
    number: integer("number").notNull(),
    displayCode: text("display_code").notNull(),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email"),
    deviceId: text("device_id"),
    source: text("source").notNull(),
    status: text("status").notNull().default("waiting"),
    /** Ordering among waiting tickets; total order is (sort_key, id) (SPEC §6.3). */
    sortKey: numeric("sort_key").notNull(),
    pushCount: integer("push_count").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    /** Latest call. The first call lives in ticket_events. */
    calledAt: timestamp("called_at", { withTimezone: true }),
    servingAt: timestamp("serving_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    calledBy: uuid("called_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("tickets_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "tickets_queue_fk",
      columns: [t.tenantId, t.queueId],
      foreignColumns: [queues.tenantId, queues.id],
    }).onDelete("cascade"),
    index("tickets_queue_status_sort_idx").on(t.queueId, t.status, t.sortKey),
    index("tickets_waiting_order_idx")
      .on(t.queueId, t.sortKey, t.id)
      .where(sql`${t.status} = 'waiting'`),
    check("tickets_source_check", sql`${t.source} in ('qr', 'walk_in')`),
    check(
      "tickets_status_check",
      sql`${t.status} in ('waiting', 'called', 'serving', 'done', 'no_show', 'cancelled', 'removed')`,
    ),
  ],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "push_subscriptions_ticket_fk",
      columns: [t.tenantId, t.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
    }).onDelete("cascade"),
    index("push_subscriptions_ticket_id_idx").on(t.ticketId),
  ],
);

/** Append-only audit log. Feeds metrics and debugging (SPEC §5). */
export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    queueId: uuid("queue_id").notNull(),
    type: text("type").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    payload: jsonb("payload").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "ticket_events_ticket_fk",
      columns: [t.tenantId, t.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
    }).onDelete("cascade"),
    index("ticket_events_ticket_id_idx").on(t.ticketId),
    index("ticket_events_queue_id_at_idx").on(t.queueId, t.at),
    // Notification dedupe (SPEC §8): at most one 'notified' event per ticket and kind.
    uniqueIndex("ticket_events_notified_once_idx")
      .on(t.ticketId, sql`(${t.payload} ->> 'kind')`)
      .where(sql`${t.type} = 'notified'`),
    check(
      "ticket_events_type_check",
      sql`${t.type} in ('joined', 'called', 'pushed_back', 'serving', 'done', 'no_show', 'cancelled', 'removed', 'notified')`,
    ),
    check("ticket_events_actor_type_check", sql`${t.actorType} in ('customer', 'staff', 'system')`),
  ],
);
