import { describe, expect, it } from "vitest";
import {
  canTransition,
  fromStatesFor,
  InvalidTransitionError,
  isFinal,
  nextStatus,
  TICKET_ACTIONS,
  TICKET_STATUSES,
  type TicketAction,
  type TicketStatus,
} from "./state-machine.ts";

/** The whole table, written out by hand. Every (status, action) pair not listed must be rejected. */
const ALLOWED: Array<[TicketStatus, TicketAction, TicketStatus]> = [
  ["waiting", "call", "called"],
  ["waiting", "cancel", "cancelled"],
  ["waiting", "remove", "removed"],
  ["called", "start", "serving"],
  ["called", "push_back", "waiting"],
  ["called", "no_show", "no_show"],
  ["called", "cancel", "cancelled"],
  ["called", "remove", "removed"],
  ["serving", "finish", "done"],
];

const allPairs = TICKET_STATUSES.flatMap((status) =>
  TICKET_ACTIONS.map((action) => [status, action] as const),
);

describe("ticket state machine", () => {
  it("covers all 49 status × action pairs", () => {
    expect(allPairs).toHaveLength(49);
  });

  it.each(allPairs)("%s + %s", (status, action) => {
    const expected = ALLOWED.find(([from, act]) => from === status && act === action)?.[2];

    expect(nextStatus(status, action)).toBe(expected);
    expect(canTransition(status, action)).toBe(expected !== undefined);
  });

  it("lists the source statuses of each action", () => {
    expect(fromStatesFor("call")).toEqual(["waiting"]);
    expect(fromStatesFor("cancel")).toEqual(["waiting", "called"]);
    expect(fromStatesFor("finish")).toEqual(["serving"]);
  });

  it("knows which statuses are final", () => {
    expect(TICKET_STATUSES.filter(isFinal)).toEqual(["done", "no_show", "cancelled", "removed"]);
  });

  it("explains a rejected move in plain words, as a 409", () => {
    const error = new InvalidTransitionError("done", "push_back");

    expect(error.status).toBe(409);
    expect(error.code).toBe("invalid_transition");
    expect(error.message).toBe("Can't push back a ticket that is done");
  });
});
