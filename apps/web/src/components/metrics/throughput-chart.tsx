"use client";

import type { DailyMetrics } from "@waitless/shared";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const SERIES = "#2a78d6"; // sequential blue, step 450
const GRID = "#e7e5e4";
const MUTED = "#57534e";

/** "2026-03-14" → "Mar 14". Parsed as UTC so the browser's zone can't shift the day. */
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function TooltipBody({
  active,
  payload,
}: {
  active?: boolean;
  payload?: readonly { payload: DailyMetrics }[];
}) {
  const day = payload?.[0]?.payload;
  if (!active || !day) return null;
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm shadow-sm">
      <p className="font-medium text-neutral-900">{shortDay(day.day)}</p>
      <p className="text-neutral-600">
        {day.served} served · {day.joined} joined
      </p>
    </div>
  );
}

/** Served tickets per local day. One series, so the heading names it and there's no legend. */
export function ThroughputChart({ daily }: { daily: DailyMetrics[] }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={daily}
          margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
          barCategoryGap={2}
        >
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            tick={{ fill: MUTED, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            minTickGap={16}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: MUTED, fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip content={<TooltipBody />} cursor={{ fill: "#f5f5f4" }} />
          <Bar
            dataKey="served"
            fill={SERIES}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
