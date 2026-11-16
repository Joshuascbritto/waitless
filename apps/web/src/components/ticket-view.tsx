"use client";

import { isFinal, type PublicTicketViewResponse, type TicketStatus } from "@waitless/shared";
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { etaText, ticketStorageKey, writeStorage } from "@/lib/format";
import { useEventStream } from "@/lib/use-event-stream";
import { NotifyButton } from "./notify-button";
import { StreamBadge } from "./stream-badge";

const HEADLINE: Record<TicketStatus, string> = {
  waiting: "You're in line",
  called: "It's your turn!",
  serving: "You're being served",
  done: "All done. Thanks for coming!",
  no_show: "We called you, but missed you",
  cancelled: "You left the line",
  removed: "This ticket was removed",
};

export function TicketView({ tenantSlug, token }: { tenantSlug: string; token: string }) {
  // Live updates over SSE; the stream closes itself once the ticket is over.
  const { data, status } = useEventStream<PublicTicketViewResponse>(
    `/api/public/q/${tenantSlug}/t/${token}/stream`,
    "ticket",
    (view) => isFinal(view.status),
  );
  const [leaving, setLeaving] = useState(false);

  // Remember the ticket while it's active, forget it once it's over.
  useEffect(() => {
    if (!data) return;
    const key = ticketStorageKey(tenantSlug, data.queueSlug);
    writeStorage(key, isFinal(data.status) ? null : token);
  }, [data, tenantSlug, token]);

  if (!data) {
    if (status === "failed") {
      return (
        <p className="text-neutral-600">This ticket doesn't exist or the link is incomplete.</p>
      );
    }
    return <p className="text-neutral-500">Loading your ticket…</p>;
  }

  async function leave() {
    if (!window.confirm("Leave the line? You'll lose your place.")) return;
    setLeaving(true);
    try {
      // The stream delivers the new "cancelled" state.
      await apiRequest(`/api/public/q/${tenantSlug}/t/${token}`, { method: "DELETE" });
    } finally {
      setLeaving(false);
    }
  }

  const active = !isFinal(data.status);
  const yourTurn = data.status === "called";

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-neutral-500">
          {data.tenantName} · {data.queueName}
        </p>
        <h1
          className={`text-3xl font-semibold tracking-tight ${yourTurn ? "text-emerald-700" : ""}`}
          aria-live="polite"
        >
          {HEADLINE[data.status]}
        </h1>
      </header>

      <div
        className={`flex flex-col items-center gap-1 rounded-2xl p-8 ${yourTurn ? "bg-emerald-600 text-white" : "bg-neutral-900 text-white"}`}
      >
        <span className="text-sm opacity-80">Your ticket</span>
        <span className="font-mono text-6xl font-bold tracking-tight">{data.displayCode}</span>
      </div>

      {data.status === "waiting" && data.position !== null ? (
        <dl className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-neutral-100 p-4">
            <dt className="text-sm text-neutral-500">Your place</dt>
            <dd className="text-3xl font-semibold">#{data.position}</dd>
          </div>
          <div className="rounded-xl bg-neutral-100 p-4">
            <dt className="text-sm text-neutral-500">Estimated wait</dt>
            <dd className="text-xl font-semibold">{etaText(data.etaRange)}</dd>
          </div>
        </dl>
      ) : null}

      {data.nowServing.length > 0 && active ? (
        <p className="text-neutral-600">
          Now serving: <span className="font-mono font-medium">{data.nowServing.join(", ")}</span>
        </p>
      ) : null}

      {data.status === "waiting" ? <NotifyButton tenantSlug={tenantSlug} token={token} /> : null}

      {active && data.status !== "serving" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-500">
            Keep this page open. It updates by itself. <StreamBadge status={status} />
          </p>
          <button
            type="button"
            onClick={leave}
            disabled={leaving}
            className="self-start text-sm text-red-700 underline-offset-4 hover:underline disabled:opacity-60"
          >
            Leave the line
          </button>
        </div>
      ) : null}

      {active ? null : (
        <a
          href={`/q/${tenantSlug}/${data.queueSlug}`}
          className="self-start rounded-lg border border-neutral-300 px-4 py-2.5 font-medium hover:border-neutral-900"
        >
          Join the line again
        </a>
      )}
    </div>
  );
}
