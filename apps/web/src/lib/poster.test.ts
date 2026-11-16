import { describe, expect, it } from "vitest";
import { resolvePublicOrigin } from "./public-origin";
import { qrSvgPath } from "./qr";

describe("resolvePublicOrigin", () => {
  const none = { host: null, forwardedHost: null, forwardedProto: null };

  it("prefers APP_ORIGIN", () => {
    expect(
      resolvePublicOrigin("https://waitless.example/", { ...none, host: "internal:3000" }),
    ).toBe("https://waitless.example");
  });

  it("falls back to the forwarded host and protocol, then the host header", () => {
    expect(
      resolvePublicOrigin(undefined, {
        host: "web:3000",
        forwardedHost: "demo.example, proxy",
        forwardedProto: "https",
      }),
    ).toBe("https://demo.example");
    expect(resolvePublicOrigin("", { ...none, host: "192.168.0.10:3000" })).toBe(
      "http://192.168.0.10:3000",
    );
    expect(resolvePublicOrigin(undefined, none)).toBe("http://localhost:3000");
  });
});

describe("qrSvgPath", () => {
  it("draws a version-sized code with a quiet zone", () => {
    const { viewBox, d } = qrSvgPath("https://demo.example/q/barbearia-demo/haircut");
    // Versions are 21, 25, 29... modules wide, plus 4 on each side.
    expect((viewBox - 8 - 21) % 4).toBe(0);
    // The top-left finder pattern starts at the quiet zone's edge.
    expect(d.startsWith("M4 4h1v1h-1z")).toBe(true);
  });
});
