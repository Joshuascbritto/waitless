"use client";

import type { AdminTicket, Board } from "@waitless/shared";
import Link from "next/link";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ApiError, apiRequest } from "@/lib/api";
import { minutesAgo } from "@/lib/format";
import { useEventStream } from "@/lib/use-event-stream";
import { StreamBadge } from "./stream-badge";

type ActionPath = "call" | "start" | "finish" | "push-back" | "no-show" | "remove";

interface Props {
  tenantSlug: string;
  queueId: string;
  isOwner: boolean;
}

/** The staff screen: who's waiting, who's called, who's being served, and the buttons. */
export function QueueBoard({ tenantSlug, queueId, isOwner }: Props) {
  const base = `/api/admin/${tenantSlug}` as const;
  // The server pushes the whole board on connect and after every change, from any replica.
  const { data: board, status } = useEventStream<Board>(
    `${base}/queues/${queueId}/stream`,
    "board",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Re-render every 30 s so "joined 3 min ago" stays true without new events.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      // No refetch: the result arrives through the stream.
      setBusy(false);
    }
  }

  const act = (ticket: AdminTicket, action: ActionPath) =>
    run(() => apiRequest(`${base}/tickets/${ticket.id}/${action}`, { method: "POST" }));

  const callNext = () =>
    run(async () => {
      const result = await apiRequest<{ ticket: AdminTicket } | undefined>(
        `${base}/queues/${queueId}/call-next`,
        { method: "POST" },
      );
      if (!result) setMessage("Nobody is waiting.");
    });

  async function addWalkIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const name = new FormData(formElement).get("name");
    await run(() =>
      apiRequest(`${base}/queues/${queueId}/walk-ins`, { method: "POST", body: { name } }),
    );
    formElement.reset();
  }

  if (!board) {
    return (
      <p className="text-neutral-500">
        {status === "failed" ? "Couldn't open this queue." : "Loading…"}
      </p>
    );
  }
  const { queue } = board;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{queue.name}</h1>
          <p className="text-sm text-neutral-500">
            {queue.isOpen ? "Open" : "Closed to new customers"} · Customer link:{" "}
            <a
              className="underline"
              href={`/q/${tenantSlug}/${queue.slug}`}
              target="_blank"
              rel="noreferrer"
            >
              /q/{tenantSlug}/{queue.slug}
            </a>
          </p>
          <StreamBadge status={status} />
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/admin/${tenantSlug}/queues/${queueId}/poster`}
            className="text-sm underline"
          >
            QR poster
          </Link>
          {isOwner ? (
            <Link
              href={`/admin/${tenantSlug}/queues/${queueId}/settings`}
              className="text-sm underline"
            >
              Settings
            </Link>
          ) : null}
          <button
            type="button"
            onClick={callNext}
            disabled={busy}
            className="rounded-lg bg-neutral-900 px-5 py-3 font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
          >
            Call next
          </button>
        </div>
      </header>

      <p role="status" aria-live="polite" className="min-h-5 text-sm text-amber-800">
        {message}
      </p>

      <div className="grid gap-6 lg:grid-cols-3">
        <Column title="Called" count={board.called.length}>
          {board.called.map((t) => (
            <TicketCard key={t.id} ticket={t} detail={`called ${minutesAgo(t.calledAt)}`}>
              <ActionButton onClick={() => act(t, "start")} disabled={busy} primary>
                Start
              </ActionButton>
              <ActionButton onClick={() => act(t, "push-back")} disabled={busy}>
                Push back
              </ActionButton>
              <ActionButton onClick={() => act(t, "no-show")} disabled={busy}>
                No-show
              </ActionButton>
            </TicketCard>
          ))}
        </Column>

        <Column title="Serving" count={board.serving.length}>
          {board.serving.map((t) => (
            <TicketCard key={t.id} ticket={t} detail={`started ${minutesAgo(t.servingAt)}`}>
              <ActionButton onClick={() => act(t, "finish")} disabled={busy} primary>
                Done
              </ActionButton>
            </TicketCard>
          ))}
        </Column>

        <Column title="Waiting" count={board.waiting.length}>
          {board.waiting.map((t, index) => (
            <TicketCard
              key={t.id}
              ticket={t}
              detail={`#${index + 1} · joined ${minutesAgo(t.joinedAt)}${t.pushCount ? ` · pushed back ×${t.pushCount}` : ""}`}
            >
              <ActionButton onClick={() => act(t, "call")} disabled={busy}>
                Call
              </ActionButton>
              <ActionButton
                onClick={() => {
                  if (window.confirm(`Remove ${t.customerName} from the line?`))
                    void act(t, "remove");
                }}
                disabled={busy}
              >
                Remove
              </ActionButton>
            </TicketCard>
          ))}
          <form onSubmit={addWalkIn} className="flex gap-2">
            <input
              name="name"
              required
              maxLength={60}
              placeholder="Walk-in name"
              aria-label="Walk-in customer name"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium hover:border-neutral-900 disabled:opacity-60"
            >
              Add
            </button>
          </form>
        </Column>
      </div>
    </div>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-neutral-500 uppercase">
        {title} <span className="text-neutral-400">({count})</span>
      </h2>
      {children}
    </section>
  );
}

function TicketCard({
  ticket,
  detail,
  children,
}: {
  ticket: AdminTicket;
  detail: string;
  children: ReactNode;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-lg font-semibold">{ticket.displayCode}</span>
        {ticket.source === "walk_in" ? (
          <span className="text-xs text-neutral-500">walk-in</span>
        ) : null}
      </div>
      <div>
        <p className="font-medium">{ticket.customerName}</p>
        <p className="text-sm text-neutral-500">{detail}</p>
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </article>
  );
}

function ActionButton({
  onClick,
  disabled,
  primary,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${primary ? "bg-neutral-900 text-white hover:bg-neutral-800" : "border border-neutral-300 hover:border-neutral-900"}`}
    >
      {children}
    </button>
  );
}
