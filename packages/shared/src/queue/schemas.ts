/** API contracts for queues and tickets, shared by the API (validation) and the web app (types). */
import { z } from "zod";
import { SlugSchema } from "../tenant.ts";
import { TICKET_STATUSES } from "./state-machine.ts";

export const TicketStatusSchema = z.enum(TICKET_STATUSES);

const minutes = (max: number) => z.number().int().min(1).max(max);

export const QueueSettingsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  slug: SlugSchema,
  /** One uppercase letter shown before the number: "A-023". */
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]$/, "One letter, A to Z"),
  isOpen: z.boolean(),
  activeServers: z.number().int().min(1).max(50),
  defaultServiceMinutes: minutes(480),
  notifyWhenAhead: z.number().int().min(0).max(20),
  noShowAfterMinutes: minutes(120),
});

export const CreateQueueInputSchema = QueueSettingsSchema.partial().required({
  name: true,
  slug: true,
});
export type CreateQueueInput = z.infer<typeof CreateQueueInputSchema>;

export const UpdateQueueInputSchema = QueueSettingsSchema.partial();
export type UpdateQueueInput = z.infer<typeof UpdateQueueInputSchema>;

export const QueueSchema = QueueSettingsSchema.extend({ id: z.uuid() });
export type Queue = z.infer<typeof QueueSchema>;

export const QueueListResponseSchema = z.object({ queues: z.array(QueueSchema) });

export const EtaRangeSchema = z.object({ minMinutes: z.number(), maxMinutes: z.number() });

// --- Customer side --------------------------------------------------------------

export const JoinQueueInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email())
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
export type JoinQueueInput = z.infer<typeof JoinQueueInputSchema>;

export const JoinQueueResponseSchema = z.object({
  token: z.string(),
  displayCode: z.string(),
});
export type JoinQueueResponse = z.infer<typeof JoinQueueResponseSchema>;

export const PublicQueueInfoSchema = z.object({
  tenantName: z.string(),
  name: z.string(),
  isOpen: z.boolean(),
  waitingCount: z.number().int(),
  /** Wait for someone joining now; null if they'd be next. */
  etaRange: EtaRangeSchema.nullable(),
});
export type PublicQueueInfo = z.infer<typeof PublicQueueInfoSchema>;

export const PublicTicketViewSchema = z.object({
  tenantName: z.string(),
  queueName: z.string(),
  queueSlug: z.string(),
  displayCode: z.string(),
  status: TicketStatusSchema,
  position: z.number().int().nullable(),
  etaRange: EtaRangeSchema.nullable(),
  nowServing: z.array(z.string()),
});
export type PublicTicketViewResponse = z.infer<typeof PublicTicketViewSchema>;

// --- Staff side -----------------------------------------------------------------

export const AdminTicketSchema = z.object({
  id: z.uuid(),
  displayCode: z.string(),
  customerName: z.string(),
  customerEmail: z.string().nullable(),
  source: z.enum(["qr", "walk_in"]),
  status: TicketStatusSchema,
  pushCount: z.number().int(),
  joinedAt: z.iso.datetime({ offset: true }),
  calledAt: z.iso.datetime({ offset: true }).nullable(),
  servingAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AdminTicket = z.infer<typeof AdminTicketSchema>;

export const BoardSchema = z.object({
  queue: QueueSchema,
  /** In queue order. */
  waiting: z.array(AdminTicketSchema),
  called: z.array(AdminTicketSchema),
  serving: z.array(AdminTicketSchema),
});
export type Board = z.infer<typeof BoardSchema>;

export const WalkInInputSchema = z.object({ name: z.string().trim().min(1).max(60) });

export const PushBackInputSchema = z.object({
  /** How many waiting customers go ahead (SPEC §6.3). */
  n: z.number().int().min(1).max(20).default(2),
});

/** URL form of the staff actions: POST /api/admin/:tenantSlug/tickets/:id/{action}. */
export const TICKET_ACTION_PATHS = {
  call: "call",
  start: "start",
  finish: "finish",
  "push-back": "push_back",
  "no-show": "no_show",
  remove: "remove",
} as const;
