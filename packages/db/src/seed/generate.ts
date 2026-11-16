/**
 * Synthetic queue history for the demo (SPEC §13). Pure: no database, so it's
 * unit-tested and the same seed always yields the same history.
 *
 * Model, per local day: arrivals per open hour are Poisson around a rate that
 * depends on weekday and hour; `activeServers` staff serve first come, first
 * served; service time is normal around the queue's default. About 8% of
 * customers give up while waiting and 5% don't show up when called.
 */
import { normal, pick, poisson, type Random, uniform } from "./random.ts";
import { addDays, isoWeekday, type LocalDay, localTimeToInstant } from "./time.ts";

export const CANCEL_RATE = 0.08;
export const NO_SHOW_RATE = 0.05;
const WALK_IN_RATE = 0.15;

export interface ArrivalProfile {
  /** Opening hours per ISO weekday (1 = Monday … 7 = Sunday): [open, close) local hours, or null if closed. */
  hours: Readonly<Record<number, readonly [number, number] | null>>;
  /** Expected joins per open hour on an ordinary day. */
  baseRate: number;
  /** Busier or quieter than base at this weekday and hour (busy Friday evening: > 1). */
  multiplier(weekday: number, hour: number): number;
}

export interface SimulatedQueue {
  activeServers: number;
  defaultServiceMinutes: number;
  noShowAfterMinutes: number;
}

export interface SimulatedTicket {
  day: LocalDay;
  /** Daily number, 1.. in join order. */
  number: number;
  customerName: string;
  source: "qr" | "walk_in";
  status: "done" | "cancelled" | "no_show";
  joinedAt: Date;
  calledAt: Date | null;
  servingAt: Date | null;
  finishedAt: Date;
}

const FIRST_NAMES = [
  "Ana",
  "Bruno",
  "Carla",
  "Diego",
  "Eduarda",
  "Felipe",
  "Gabriela",
  "Henrique",
  "Isabela",
  "João",
  "Larissa",
  "Lucas",
  "Mariana",
  "Mateus",
  "Natália",
  "Otávio",
  "Paula",
  "Rafael",
  "Sofia",
  "Thiago",
  "Vitória",
  "Yuri",
] as const;
const INITIALS = "ABCDFGLMNPRST";

export function fakeCustomerName(random: Random): string {
  return `${pick(random, FIRST_NAMES)} ${pick(random, [...INITIALS])}.`;
}

interface Draft {
  joined: number; // local minutes since midnight
  called: number | null;
  serving: number | null;
  finished: number;
  status: SimulatedTicket["status"];
  source: SimulatedTicket["source"];
  customerName: string;
}

/** One local day of one queue, in local minutes; not yet filtered by "now". */
function simulateDay(
  day: LocalDay,
  queue: SimulatedQueue,
  profile: ArrivalProfile,
  random: Random,
): Draft[] {
  const weekday = isoWeekday(day);
  const hours = profile.hours[weekday];
  if (!hours) return [];
  const [open, close] = hours;

  const arrivals: number[] = [];
  for (let hour = open; hour < close; hour++) {
    const count = poisson(random, profile.baseRate * profile.multiplier(weekday, hour));
    for (let i = 0; i < count; i++) arrivals.push(uniform(random, hour * 60, hour * 60 + 60));
  }
  arrivals.sort((a, b) => a - b);

  // When each server is next free, in local minutes.
  const freeAt = Array<number>(queue.activeServers).fill(open * 60);
  const mean = queue.defaultServiceMinutes;

  return arrivals.map((joined): Draft => {
    const base = {
      joined,
      customerName: fakeCustomerName(random),
      source: random() < WALK_IN_RATE ? ("walk_in" as const) : ("qr" as const),
    };
    const outcome = random();
    if (outcome < CANCEL_RATE) {
      // Gave up while waiting; never took a server's time.
      return {
        ...base,
        status: "cancelled",
        called: null,
        serving: null,
        finished: joined + uniform(random, 3, 25),
      };
    }

    const server = freeAt.indexOf(Math.min(...freeAt));
    const called = Math.max(joined, freeAt[server] ?? joined) + uniform(random, 0.2, 1.5);

    if (outcome < CANCEL_RATE + NO_SHOW_RATE) {
      // Staff moves on after a couple of minutes; auto no-show closes the ticket later.
      freeAt[server] = called + uniform(random, 1, 3);
      return {
        ...base,
        status: "no_show",
        called,
        serving: null,
        finished: called + queue.noShowAfterMinutes,
      };
    }

    const serving = called + uniform(random, 0.5, 2);
    const service = Math.min(Math.max(normal(random, mean, mean * 0.25), mean * 0.4), mean * 2);
    const finished = serving + service;
    freeAt[server] = finished;
    return { ...base, status: "done", called, serving, finished };
  });
}

export interface HistoryInput {
  queue: SimulatedQueue;
  profile: ArrivalProfile;
  timezone: string;
  /** Today in the tenant's timezone; history covers `days` local days ending today. */
  today: LocalDay;
  days: number;
  /** Tickets not finished by now are left out: the seed adds "live" tickets separately. */
  now: Date;
  random: Random;
}

/**
 * Finished tickets for `days` local days ending `today`. Numbering restarts
 * each day and is assigned after filtering, so it never has gaps.
 */
export function simulateHistory(input: HistoryInput): SimulatedTicket[] {
  const out: SimulatedTicket[] = [];
  for (let offset = input.days - 1; offset >= 0; offset--) {
    const day = addDays(input.today, -offset);
    const at = (minutes: number) => localTimeToInstant(day, minutes, input.timezone);

    const finished = simulateDay(day, input.queue, input.profile, input.random)
      .map((d) => ({
        draft: d,
        joinedAt: at(d.joined),
        finishedAt: at(d.finished),
      }))
      .filter((t) => t.finishedAt.getTime() <= input.now.getTime());

    finished.forEach(({ draft, joinedAt, finishedAt }, index) => {
      out.push({
        day,
        number: index + 1,
        customerName: draft.customerName,
        source: draft.source,
        status: draft.status,
        joinedAt,
        calledAt: draft.called === null ? null : at(draft.called),
        servingAt: draft.serving === null ? null : at(draft.serving),
        finishedAt,
      });
    });
  }
  return out;
}
