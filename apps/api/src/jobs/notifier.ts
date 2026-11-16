/**
 * Delivery channel behind an interface (SPEC §8): jobs decide WHAT to send,
 * a Notifier decides HOW. Web Push now; email (Resend) in v1.1 plugs in here.
 */
import { isAllowedPushEndpoint, type PushMessage } from "@waitless/shared";
import { sendNotification, setVapidDetails, WebPushError } from "web-push";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * "delivered", or "gone" when the push service says the subscription no
 * longer exists (404/410) and it should be deleted. Anything else throws, so
 * the job is retried.
 */
export type DeliveryResult = "delivered" | "gone";

export interface Notifier {
  send(target: PushTarget, message: PushMessage): Promise<DeliveryResult>;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** "mailto:..." or an https URL: lets push services contact the sender. */
  subject: string;
}

export class WebPushNotifier implements Notifier {
  constructor(vapid: VapidConfig) {
    setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async send(target: PushTarget, message: PushMessage): Promise<DeliveryResult> {
    // Defense in depth: rows saved before the allowlist existed, or written by
    // any other path, never make us contact an arbitrary host. Drop them.
    if (!isAllowedPushEndpoint(target.endpoint)) {
      return "gone";
    }
    try {
      await sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        // A "your turn" that arrives an hour late is worse than none.
        { TTL: 15 * 60, urgency: "high" },
      );
      return "delivered";
    } catch (error) {
      if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
        return "gone";
      }
      throw error;
    }
  }
}
