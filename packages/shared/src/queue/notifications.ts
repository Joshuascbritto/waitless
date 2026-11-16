/** What gets notified, when, and what it says (SPEC §8). Pure, so it's tested without push services. */
import { z } from "zod";

/**
 * "Almost up" goes out once a waiting customer has at most `notifyWhenAhead`
 * people ahead (position − 1). 0 turns it off for the queue.
 */
export function shouldNotifyAlmostUp(position: number, notifyWhenAhead: number): boolean {
  return notifyWhenAhead > 0 && position - 1 <= notifyWhenAhead;
}

/**
 * Dedupe key per notification. "Almost up" once per ticket; "your turn" once
 * per CALL, so a customer pushed back and called again is told again.
 */
export function notificationKind(kind: "almost"): "almost";
export function notificationKind(kind: "called", calledAtMs: number): `called:${number}`;
export function notificationKind(kind: "almost" | "called", calledAtMs?: number): string {
  return kind === "almost" ? "almost" : `called:${calledAtMs}`;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Opened when the notification is tapped. */
  url: string;
  /** Same tag replaces an older notification instead of stacking. */
  tag: string;
}

export function almostUpMessage(input: {
  tenantName: string;
  ahead: number;
  displayCode: string;
  url: string;
}): PushMessage {
  const body =
    input.ahead === 0
      ? `You're next. Ticket ${input.displayCode}.`
      : `${input.ahead} ahead of you. Ticket ${input.displayCode}.`;
  return {
    title: `You're almost up at ${input.tenantName}`,
    body,
    url: input.url,
    tag: input.displayCode,
  };
}

export function yourTurnMessage(input: {
  tenantName: string;
  displayCode: string;
  url: string;
}): PushMessage {
  return {
    title: "It's your turn!",
    body: `Ticket ${input.displayCode} at ${input.tenantName}`,
    url: input.url,
    tag: input.displayCode,
  };
}

/**
 * Push services browsers actually use. The endpoint comes from an anonymous
 * client and the worker POSTs to it, so without this allowlist anyone could
 * make our servers send requests to an arbitrary host (SSRF), including
 * internal ones. Exact host or dot-anchored subdomain.
 */
export const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com", // Chrome, Android, Opera, Samsung Internet
  "push.services.mozilla.com", // Firefox (updates.push.services.mozilla.com)
  "web.push.apple.com", // Safari, iOS home-screen apps
  "notify.windows.com", // Edge (*.notify.windows.com)
] as const;

/** HTTPS on the default port, on a known push service host. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** What a browser's PushSubscription.toJSON() sends us. */
export const PushSubscriptionInputSchema = z.object({
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .refine(isAllowedPushEndpoint, { message: "Not a known Web Push service" }),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInputSchema>;

export const PushKeyResponseSchema = z.object({
  /** VAPID public key, base64url; null when push isn't configured on this server. */
  publicKey: z.string().nullable(),
});
