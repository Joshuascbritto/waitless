import { describe, expect, it } from "vitest";
import {
  almostUpMessage,
  isAllowedPushEndpoint,
  notificationKind,
  PushSubscriptionInputSchema,
  shouldNotifyAlmostUp,
  yourTurnMessage,
} from "./notifications.ts";

describe("shouldNotifyAlmostUp", () => {
  it.each([
    [1, 2, true],
    [3, 2, true],
    [4, 2, false],
    [1, 0, false],
    [2, 1, true],
    [3, 1, false],
  ])("position %d, notify when %d ahead → %s", (position, notifyWhenAhead, expected) => {
    expect(shouldNotifyAlmostUp(position, notifyWhenAhead)).toBe(expected);
  });
});

describe("notificationKind", () => {
  it("is fixed for 'almost' and per call for 'called'", () => {
    expect(notificationKind("almost")).toBe("almost");
    expect(notificationKind("called", 1794836255362)).toBe("called:1794836255362");
  });
});

describe("messages", () => {
  it("say how many are ahead, or that you're next", () => {
    const base = { tenantName: "Barbearia do Zé", displayCode: "A-023", url: "/q/x/t/y" };

    expect(almostUpMessage({ ...base, ahead: 2 })).toMatchObject({
      title: "You're almost up at Barbearia do Zé",
      body: "2 ahead of you. Ticket A-023.",
    });
    expect(almostUpMessage({ ...base, ahead: 0 }).body).toBe("You're next. Ticket A-023.");
    expect(yourTurnMessage(base)).toEqual({
      title: "It's your turn!",
      body: "Ticket A-023 at Barbearia do Zé",
      url: "/q/x/t/y",
      tag: "A-023",
    });
  });
});

describe("PushSubscriptionInputSchema", () => {
  it("accepts a browser subscription and rejects non-HTTPS endpoints", () => {
    const keys = { p256dh: "BNc...", auth: "tBH..." };

    expect(
      PushSubscriptionInputSchema.safeParse({ endpoint: "https://fcm.googleapis.com/x", keys })
        .success,
    ).toBe(true);
    expect(
      PushSubscriptionInputSchema.safeParse({ endpoint: "http://evil.example/x", keys }).success,
    ).toBe(false);
    expect(
      PushSubscriptionInputSchema.safeParse({ endpoint: "https://internal.example/x", keys })
        .success,
    ).toBe(false);
  });
});

describe("isAllowedPushEndpoint (SSRF guard)", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QH8...",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://FCM.googleapis.com./fcm/send/abc",
  ])("accepts %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/x",
    "https://10.0.0.5/x",
    "https://api-1:3001/api/admin",
    "https://fcm.googleapis.com:8443/x",
    "https://evilfcm.googleapis.com.attacker.example/x",
    "https://notfcm.googleapis.com.evil/x",
    "https://user:pass@fcm.googleapis.com/x",
    "http://fcm.googleapis.com/x",
    "not a url",
  ])("rejects %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});
