/**
 * The origin customers reach the app at, for links printed on the QR poster.
 * APP_ORIGIN wins when set (production, behind a proxy). Otherwise the
 * request's own host: right in dev, including a phone on the LAN. The header
 * fallback only affects what the signed-in staff member sees on their poster.
 */
export function resolvePublicOrigin(
  appOrigin: string | undefined,
  headers: { host: string | null; forwardedHost: string | null; forwardedProto: string | null },
): string {
  if (appOrigin && appOrigin.trim() !== "") {
    return new URL(appOrigin).origin;
  }
  const host = headers.forwardedHost?.split(",")[0]?.trim() || headers.host || "localhost:3000";
  const proto = headers.forwardedProto?.split(",")[0]?.trim() === "https" ? "https" : "http";
  return new URL(`${proto}://${host}`).origin;
}
