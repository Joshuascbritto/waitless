import { describe, expect, it } from "vitest";
import {
  hashSessionToken,
  newSessionToken,
  SESSION_TTL_MS,
  shouldRenewSession,
} from "./sessions.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-16T12:00:00Z");
const inDays = (days: number) => new Date(now.getTime() + days * DAY);

describe("shouldRenewSession (14-day sliding expiry)", () => {
  it.each([
    [14, false],
    [8, false],
    [7.01, false],
    [6.99, true],
    [1, true],
    [0.001, true],
  ])("with %d days left → %s", (daysLeft, expected) => {
    expect(shouldRenewSession(inDays(daysLeft), now)).toBe(expected);
  });

  it("never renews an expired session", () => {
    expect(shouldRenewSession(inDays(0), now)).toBe(false);
    expect(shouldRenewSession(inDays(-1), now)).toBe(false);
  });

  it("uses a 14-day lifetime", () => {
    expect(SESSION_TTL_MS).toBe(14 * DAY);
  });
});

describe("session tokens", () => {
  it("are 256-bit base64url strings, unique per call", () => {
    const a = newSessionToken();
    const b = newSessionToken();

    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("are stored as a sha256 hex digest, never as-is", () => {
    const token = newSessionToken();

    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).not.toContain(token);
  });
});
