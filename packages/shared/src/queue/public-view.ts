import { averageServiceMinutes, type EtaRange, etaRangeForPosition } from "./eta.ts";
import { positionIn } from "./ordering.ts";
import type { TicketStatus } from "./state-machine.ts";

/** Everything needed to answer "where am I and how long?" for any ticket in one queue. */
export interface QueueSnapshot {
  activeServers: number;
  defaultServiceMinutes: number;
  /** Waiting tickets in queue order. */
  waiting: ReadonlyArray<{ id: string; displayCode: string }>;
  called: ReadonlyArray<{ id: string; displayCode: string }>;
  serving: ReadonlyArray<{ id: string; displayCode: string; servingAt: Date }>;
  /** Today's completed service durations, oldest first. */
  recentServiceMinutes: readonly number[];
  now: Date;
}

/**
 * What a customer sees about their own ticket. Built field by field from ids
 * and display codes only: other customers' names, emails and tokens never
 * enter this object, so they can't leak through it (SPEC §7).
 */
export interface PublicTicketView {
  displayCode: string;
  status: TicketStatus;
  /** 1-based place in line while waiting, otherwise null. */
  position: number | null;
  /** null while waiting at position 1 ("You're next") or when not waiting. */
  etaRange: EtaRange | null;
  /** Codes currently called or being served, e.g. ["A-021", "A-022"]. */
  nowServing: string[];
}

function etaInputs(snapshot: QueueSnapshot) {
  const minutes = (from: Date) => (snapshot.now.getTime() - from.getTime()) / 60_000;
  return {
    activeServers: snapshot.activeServers,
    avgServiceMinutes: averageServiceMinutes(
      snapshot.recentServiceMinutes,
      snapshot.defaultServiceMinutes,
    ),
    servingElapsedMinutes: snapshot.serving.map((t) => minutes(t.servingAt)),
  };
}

export function toPublicTicketView(
  ticket: { id: string; displayCode: string; status: TicketStatus },
  snapshot: QueueSnapshot,
): PublicTicketView {
  const position =
    ticket.status === "waiting"
      ? (positionIn(
          snapshot.waiting.map((t) => t.id),
          ticket.id,
        ) ?? null)
      : null;

  return {
    displayCode: ticket.displayCode,
    status: ticket.status,
    position,
    etaRange: position === null ? null : etaRangeForPosition({ position, ...etaInputs(snapshot) }),
    nowServing: [...snapshot.called, ...snapshot.serving].map((t) => t.displayCode),
  };
}

/** Estimate shown before joining: the wait of whoever joins now, at the end of the line. */
export function etaRangeForNewcomer(snapshot: QueueSnapshot): EtaRange | null {
  return etaRangeForPosition({ position: snapshot.waiting.length + 1, ...etaInputs(snapshot) });
}
