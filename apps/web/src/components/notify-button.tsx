"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import {
  currentSubscription,
  detectPushSupport,
  fetchPushKey,
  type PushSupport,
  subscribeToPush,
} from "@/lib/push";

type State =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "ios" }
  | { kind: "ready"; publicKey: string }
  | { kind: "working" }
  | { kind: "on" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

/** "Notify me": lets the customer leave the shop and still hear when it's their turn. */
export function NotifyButton({ tenantSlug, token }: { tenantSlug: string; token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const endpoint = `/api/public/q/${tenantSlug}/t/${token}/push` as const;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const support: PushSupport = detectPushSupport();
      if (support === "ios-needs-home-screen") return setState({ kind: "ios" });
      if (support === "unsupported") return setState({ kind: "hidden" });
      const publicKey = await fetchPushKey().catch(() => null);
      if (!publicKey) return setState({ kind: "hidden" });
      if (Notification.permission === "denied") return setState({ kind: "denied" });

      // Allowed before (e.g. on a previous ticket): attach this browser to this ticket too.
      const existing = await currentSubscription().catch(() => null);
      if (existing) {
        await apiRequest(endpoint, { method: "POST", body: existing }).catch(() => undefined);
        if (!cancelled) setState({ kind: "on" });
        return;
      }
      if (!cancelled) setState({ kind: "ready", publicKey });
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  async function enable(publicKey: string) {
    setState({ kind: "working" });
    try {
      const subscription = await subscribeToPush(publicKey);
      await apiRequest(endpoint, { method: "POST", body: subscription });
      setState({ kind: "on" });
    } catch (err) {
      if (Notification.permission === "denied") setState({ kind: "denied" });
      else setState({ kind: "error", message: err instanceof Error ? err.message : "Try again." });
    }
  }

  switch (state.kind) {
    case "loading":
    case "hidden":
      return null;
    case "ios":
      return (
        <p className="rounded-xl bg-neutral-100 p-4 text-sm text-neutral-700">
          On iPhone, tap <strong>Share → Add to Home Screen</strong> and open Waitless from there to
          get a notification when it's your turn.
        </p>
      );
    case "on":
      return <p className="text-sm text-emerald-700">We'll notify you when you're almost up.</p>;
    case "denied":
      return (
        <p className="text-sm text-neutral-600">
          Notifications are blocked for this site. Keep this page open to see your turn.
        </p>
      );
    default: {
      const publicKey = state.kind === "ready" ? state.publicKey : null;
      return (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!publicKey}
            onClick={() => publicKey && enable(publicKey)}
            className="rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
          >
            {state.kind === "working" ? "Turning on…" : "Notify me when it's my turn"}
          </button>
          <p className="text-xs text-neutral-500">
            {state.kind === "error"
              ? state.message
              : "Then you can wait anywhere nearby. We'll buzz your phone."}
          </p>
        </div>
      );
    }
  }
}
