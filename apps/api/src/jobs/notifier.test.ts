import { describe, expect, it } from "vitest";
import { generateVAPIDKeys } from "web-push";
import { WebPushNotifier } from "./notifier.ts";

describe("WebPushNotifier", () => {
  it("never contacts a host outside the push service allowlist (SSRF guard)", async () => {
    const keys = generateVAPIDKeys();
    const notifier = new WebPushNotifier({ ...keys, subject: "mailto:ops@example.com" });
    const message = { title: "t", body: "b", url: "/", tag: "x" };

    // A cloud metadata address: must be refused without any network request.
    const result = await notifier.send(
      { endpoint: "https://169.254.169.254/latest/meta-data", p256dh: "k", auth: "a" },
      message,
    );

    expect(result).toBe("gone");
  });
});
