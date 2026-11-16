const DEFAULT_API_ORIGIN = "http://localhost:3001";

/**
 * Validates and normalizes API_ORIGIN for the /api rewrite. A bad value fails
 * the Next.js boot with a clear message instead of producing silent 404s.
 */
export function resolveApiOrigin(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_API_ORIGIN;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`API_ORIGIN must be an absolute URL, got "${value}"`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`API_ORIGIN must use http or https, got "${url.protocol}"`);
  }

  return url.origin;
}
