import {
  formatDuration,
  METRICS_RANGES,
  MetricsQuerySchema,
  type MetricsRange,
  MetricsRangeSchema,
  MetricsSchema,
  QueueListResponseSchema,
} from "@waitless/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { PeakHoursHeatmap } from "@/components/metrics/peak-hours-heatmap";
import { ThroughputChart } from "@/components/metrics/throughput-chart";
import { serverGet } from "@/lib/session";

const RANGE_LABELS: Record<MetricsRange, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-neutral-200 p-4">
      <span className="text-sm text-neutral-500">{label}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
      {hint ? <span className="text-xs text-neutral-500">{hint}</span> : null}
    </div>
  );
}

function Pill({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full px-3 py-1.5 text-sm ${active ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"}`}
    >
      {children}
    </Link>
  );
}

export default async function MetricsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ range?: string; queue?: string }>;
}) {
  const [{ tenantSlug }, search] = await Promise.all([params, searchParams]);
  // Bad query values fall back to defaults instead of erroring: they come from a URL.
  const range = MetricsRangeSchema.catch("7d").parse(search.range);
  const queueId = MetricsQuerySchema.shape.queueId.catch(undefined).parse(search.queue);

  const query = new URLSearchParams({ range, ...(queueId ? { queueId } : {}) });
  const [metricsResponse, queuesResponse] = await Promise.all([
    serverGet(`/api/admin/${tenantSlug}/metrics?${query}`),
    serverGet(`/api/admin/${tenantSlug}/queues`),
  ]);
  if (!queuesResponse.ok) throw new Error(`queues failed with ${queuesResponse.status}`);
  const { queues } = QueueListResponseSchema.parse(await queuesResponse.json());
  if (!metricsResponse.ok) throw new Error(`metrics failed with ${metricsResponse.status}`);
  const metrics = MetricsSchema.parse(await metricsResponse.json());
  const { summary } = metrics;

  const href = (next: { range?: MetricsRange; queue?: string | null }) => {
    const q = new URLSearchParams({ range: next.range ?? range });
    const queue = next.queue === undefined ? queueId : next.queue;
    if (queue) q.set("queue", queue);
    return `/admin/${tenantSlug}/metrics?${q}`;
  };

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
          <p className="text-sm text-neutral-500">
            {metrics.from} to {metrics.to} · {metrics.timezone}
          </p>
        </div>
        <nav aria-label="Filters" className="flex flex-wrap items-center gap-2">
          {METRICS_RANGES.map((r) => (
            <Pill key={r} href={href({ range: r })} active={r === range}>
              {RANGE_LABELS[r]}
            </Pill>
          ))}
          <span className="mx-1 h-5 w-px bg-neutral-200" aria-hidden="true" />
          <Pill href={href({ queue: null })} active={!queueId}>
            All queues
          </Pill>
          {queues.map((q) => (
            <Pill key={q.id} href={href({ queue: q.id })} active={q.id === queueId}>
              {q.name}
            </Pill>
          ))}
        </nav>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Average wait"
          value={formatDuration(summary.avgWaitSeconds)}
          hint={`90% within ${formatDuration(summary.p90WaitSeconds)}`}
        />
        <Tile label="Average service" value={formatDuration(summary.avgServiceSeconds)} />
        <Tile
          label="Customers served"
          value={summary.served.toLocaleString("en")}
          hint={`${summary.joined.toLocaleString("en")} joined`}
        />
        <Tile
          label="Abandonment"
          value={
            summary.abandonmentRate === null
              ? "—"
              : `${(summary.abandonmentRate * 100).toFixed(1)}%`
          }
          hint={`${summary.abandoned} left or didn't show`}
        />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="font-medium">Served per day</h2>
        <ThroughputChart daily={metrics.daily} />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="font-medium">Peak hours</h2>
        <p className="text-sm text-neutral-500">When customers join, in local time.</p>
        <PeakHoursHeatmap cells={metrics.peakHours} />
      </div>
    </section>
  );
}
