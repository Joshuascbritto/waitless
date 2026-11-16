import { PushKeyResponseSchema } from "@waitless/shared";

export type PushSupport = "supported" | "unsupported" | "ios-needs-home-screen";

/** iPhone/iPad Safari only offers Web Push to sites added to the home screen. */
export function detectPushSupport(): PushSupport {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "ios-needs-home-screen";
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return "supported";
}

/** VAPID keys are base64url; PushManager wants raw bytes. */
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function fetchPushKey(): Promise<string | null> {
  const response = await fetch("/api/public/push/key");
  if (!response.ok) return null;
  return PushKeyResponseSchema.parse(await response.json()).publicKey;
}

/**
 * Asks permission, subscribes this browser and returns the subscription
 * (JSON form, ready to POST). Throws if the user declines.
 */
export async function subscribeToPush(publicKey: string): Promise<PushSubscriptionJSON> {
  const registration = await navigator.serviceWorker.register("/sw.js");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications were not allowed");
  }
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    }));
  return subscription.toJSON();
}

/** The browser's current subscription, if notifications were already allowed. */
export async function currentSubscription(): Promise<PushSubscriptionJSON | null> {
  if (Notification.permission !== "granted") return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? subscription.toJSON() : null;
}
