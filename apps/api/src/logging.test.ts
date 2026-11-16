import { describe, expect, it } from "vitest";
import { redactUrl } from "./logging.ts";

describe("redactUrl", () => {
  it("masks the ticket token in public URLs", () => {
    expect(redactUrl("/api/public/q/barbearia/t/AbC_123-xyz/stream")).toBe(
      "/api/public/q/barbearia/t/[redacted]/stream",
    );
  });

  it("masks a token followed by a query string", () => {
    expect(redactUrl("/api/public/q/barbearia/t/AbC_123?x=1")).toBe(
      "/api/public/q/barbearia/t/[redacted]?x=1",
    );
  });

  it("leaves other URLs untouched", () => {
    expect(redactUrl("/api/health/ready")).toBe("/api/health/ready");
  });
});
