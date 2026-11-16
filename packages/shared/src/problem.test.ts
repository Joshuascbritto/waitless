import { describe, expect, it } from "vitest";
import { ProblemDetailsSchema, problemTypeFor } from "./problem.ts";

describe("ProblemDetailsSchema", () => {
  it("accepts a problem with extension members", () => {
    const parsed = ProblemDetailsSchema.parse({
      type: "urn:waitless:problem:not_found",
      title: "Not Found",
      status: 404,
      detail: "Queue not found",
      requestId: "abc-123",
      extra: true,
    });

    expect(parsed.status).toBe(404);
    expect(parsed).toHaveProperty("extra", true);
  });

  it("rejects a non-error status", () => {
    expect(() =>
      ProblemDetailsSchema.parse({ type: "about:blank", title: "OK", status: 200 }),
    ).toThrow();
  });
});

describe("problemTypeFor", () => {
  it("builds a URN from the error code", () => {
    expect(problemTypeFor("invalid_transition")).toBe("urn:waitless:problem:invalid_transition");
  });
});
