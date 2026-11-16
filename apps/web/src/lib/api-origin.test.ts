import { describe, expect, it } from "vitest";
import { resolveApiOrigin } from "./api-origin";

describe("resolveApiOrigin", () => {
  it("defaults to the local API when unset or blank", () => {
    expect(resolveApiOrigin(undefined)).toBe("http://localhost:3001");
    expect(resolveApiOrigin("  ")).toBe("http://localhost:3001");
  });

  it("drops trailing slashes and paths", () => {
    expect(resolveApiOrigin("http://api:3001/")).toBe("http://api:3001");
    expect(resolveApiOrigin("https://example.com/api")).toBe("https://example.com");
  });

  it("rejects relative or non-http values", () => {
    expect(() => resolveApiOrigin("localhost:3001")).toThrow(/http or https/);
    expect(() => resolveApiOrigin("/api")).toThrow(/absolute URL/);
  });
});
