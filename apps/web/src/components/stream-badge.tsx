import type { StreamStatus } from "@/lib/use-event-stream";

/** Tells the user when live updates are paused, so a stale screen isn't trusted. */
export function StreamBadge({ status }: { status: StreamStatus }) {
  if (status === "open" || status === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700">
        <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
        Live
      </span>
    );
  }
  const label =
    status === "failed" ? "Offline" : status === "connecting" ? "Connecting…" : "Reconnecting…";
  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-xs text-amber-700">
      <span className="size-2 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
      {label}
    </span>
  );
}
