/**
 * Queue metrics (SPEC §10) in plain SQL, in the tenant's timezone. Runs inside
 * withTenant(), so RLS limits every query to one tenant; no materialized views
 * until a measured query is slow.
 *
 * Range: today plus the previous `days − 1` local days, up to `now`. A ticket
 * belongs to the range (and to a day, and to a heatmap cell) by the local time
 * it joined.
 */
import type { Metrics, MetricsRange } from "@waitless/shared";
import { rangeDays } from "@waitless/shared";
import { type SQL, sql } from "drizzle-orm";
import type { Tx } from "./client.ts";

export interface MetricsInput {
  range: MetricsRange;
  timezone: string;
  queueId?: string | undefined;
  /** Tests pin the clock; production uses the database's now(). */
  now?: Date;
}

interface Bounds extends Record<string, unknown> {
  from_day: string;
  to_day: string;
  from_ts: string;
  now_ts: string;
}

interface SummaryRow extends Record<string, unknown> {
  joined: number;
  served: number;
  abandoned: number;
  avg_wait: number | null;
  p90_wait: number | null;
  avg_service: number | null;
}

interface DailyRow extends Record<string, unknown> {
  day: string;
  joined: number;
  served: number;
}

interface CellRow extends Record<string, unknown> {
  weekday: number;
  hour: number;
  joined: number;
}

export async function loadMetrics(tx: Tx, input: MetricsInput): Promise<Metrics> {
  const days = rangeDays(input.range);
  const tz = input.timezone;
  const now: SQL = input.now ? sql`${input.now.toISOString()}::timestamptz` : sql`now()`;

  // Local "today" and the instant the range's first local day started. Turning
  // a local midnight back into an instant (timestamp AT TIME ZONE tz) handles
  // DST: the day is 23 or 25 hours long where the zone has it.
  const {
    rows: [bounds],
  } = await tx.execute<Bounds>(sql`
    select
      to_char(d.today - ${days - 1}::int, 'YYYY-MM-DD') as from_day,
      to_char(d.today, 'YYYY-MM-DD') as to_day,
      ((d.today - ${days - 1}::int)::timestamp at time zone ${tz})::text as from_ts,
      d.now_ts::text as now_ts
    from (select ${now} as now_ts, (${now} at time zone ${tz})::date as today) d
  `);
  if (!bounds) throw new Error("metrics bounds query returned no row");

  // The tickets in range, as a reusable fragment. `queueId` narrows to one queue.
  const scoped = sql`
    select t.* from tickets t
    where t.joined_at >= ${bounds.from_ts}::timestamptz
      and t.joined_at <= ${bounds.now_ts}::timestamptz
      ${input.queueId ? sql`and t.queue_id = ${input.queueId}` : sql``}
  `;

  // Wait uses the FIRST call from ticket_events: tickets.called_at is the
  // latest call and moves when a pushed-back customer is called again.
  const summaryQuery = tx.execute<SummaryRow>(sql`
    with scoped as (${scoped}),
    first_call as (
      select e.ticket_id, min(e.at) as at
      from ticket_events e
      where e.type = 'called' and e.ticket_id in (select id from scoped)
      group by e.ticket_id
    ),
    waits as (
      select extract(epoch from fc.at - s.joined_at)::float8 as seconds
      from scoped s join first_call fc on fc.ticket_id = s.id
    )
    select
      (select count(*) from scoped)::int as joined,
      (select count(*) from scoped where status = 'done')::int as served,
      (select count(*) from scoped where status in ('cancelled', 'no_show'))::int as abandoned,
      (select avg(seconds) from waits)::float8 as avg_wait,
      (select percentile_cont(0.9) within group (order by seconds) from waits)::float8 as p90_wait,
      (select avg(extract(epoch from finished_at - serving_at))
         from scoped where status = 'done' and serving_at is not null)::float8 as avg_service
  `);

  // Every day of the range, zero-filled, so the chart has no gaps.
  const dailyQuery = tx.execute<DailyRow>(sql`
    with scoped as (${scoped}),
    per_day as (
      select (joined_at at time zone ${tz})::date as day,
             count(*) as joined,
             count(*) filter (where status = 'done') as served
      from scoped group by 1
    )
    select to_char(d.day, 'YYYY-MM-DD') as day,
           coalesce(p.joined, 0)::int as joined,
           coalesce(p.served, 0)::int as served
    from generate_series(${bounds.from_day}::date, ${bounds.to_day}::date, interval '1 day') as d(day)
    left join per_day p on p.day = d.day::date
    order by d.day
  `);

  const peakQuery = tx.execute<CellRow>(sql`
    with scoped as (${scoped})
    select extract(isodow from joined_at at time zone ${tz})::int as weekday,
           extract(hour from joined_at at time zone ${tz})::int as hour,
           count(*)::int as joined
    from scoped group by 1, 2 order by 1, 2
  `);

  // Drizzle queries run when awaited; one connection runs them one at a time.
  const summary = (await summaryQuery).rows[0];
  const daily = (await dailyQuery).rows;
  const peak = (await peakQuery).rows;
  if (!summary) throw new Error("metrics summary query returned no row");

  const finished = summary.served + summary.abandoned;
  return {
    range: input.range,
    timezone: tz,
    from: bounds.from_day,
    to: bounds.to_day,
    summary: {
      joined: summary.joined,
      served: summary.served,
      abandoned: summary.abandoned,
      abandonmentRate: finished === 0 ? null : summary.abandoned / finished,
      avgWaitSeconds: summary.avg_wait,
      p90WaitSeconds: summary.p90_wait,
      avgServiceSeconds: summary.avg_service,
    },
    daily: daily.map((d) => ({ day: d.day, joined: d.joined, served: d.served })),
    peakHours: peak.map((c) => ({ weekday: c.weekday, hour: c.hour, joined: c.joined })),
  };
}
