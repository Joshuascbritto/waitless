/**
 * Ticket lifecycle (SPEC §6.1):
 *
 *   waiting ──call──► called ──start──► serving ──finish──► done
 *      │                 │  └──push_back──► waiting
 *      │                 ├──no_show──► no_show
 *      ├──cancel (customer, also from called)──► cancelled
 *      └──remove (staff, also from called)──► removed
 *
 * Anything not in the table is rejected with 409 (InvalidTransitionError).
 */
import { DomainError } from "../errors.ts";

export const TICKET_STATUSES = [
  "waiting",
  "called",
  "serving",
  "done",
  "no_show",
  "cancelled",
  "removed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_ACTIONS = [
  "call",
  "start",
  "finish",
  "push_back",
  "no_show",
  "cancel",
  "remove",
] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

const TRANSITIONS: Readonly<Record<TicketStatus, Partial<Record<TicketAction, TicketStatus>>>> = {
  waiting: { call: "called", cancel: "cancelled", remove: "removed" },
  called: {
    start: "serving",
    push_back: "waiting",
    no_show: "no_show",
    cancel: "cancelled",
    remove: "removed",
  },
  serving: { finish: "done" },
  done: {},
  no_show: {},
  cancelled: {},
  removed: {},
};

/** The status `action` leads to from `from`, or undefined if the move isn't allowed. */
export function nextStatus(from: TicketStatus, action: TicketAction): TicketStatus | undefined {
  return TRANSITIONS[from][action];
}

export function canTransition(from: TicketStatus, action: TicketAction): boolean {
  return nextStatus(from, action) !== undefined;
}

/**
 * Statuses from which `action` is allowed. The database layer uses it in a
 * conditional UPDATE (`WHERE status = ANY(...)`), so the check and the write
 * are one atomic statement instead of a racy read-then-write.
 */
export function fromStatesFor(action: TicketAction): TicketStatus[] {
  return TICKET_STATUSES.filter((status) => canTransition(status, action));
}

/** A ticket that will never move again. */
export function isFinal(status: TicketStatus): boolean {
  return TICKET_ACTIONS.every((action) => !canTransition(status, action));
}

export class InvalidTransitionError extends DomainError {
  override readonly code = "invalid_transition";
  override readonly status = 409;

  readonly from: TicketStatus;
  readonly action: TicketAction;

  // No parameter properties: `erasableSyntaxOnly` keeps the code runnable by Node's type stripping.
  constructor(from: TicketStatus, action: TicketAction) {
    super(`Can't ${action.replace("_", " ")} a ticket that is ${from.replace("_", " ")}`);
    this.from = from;
    this.action = action;
  }
}
