import { describe, expect, it } from "vitest";
import { ConflictError, DomainError, NotFoundError } from "./errors.ts";

describe("DomainError subclasses", () => {
  it("carry status, code and their own class name", () => {
    const error = new NotFoundError("Queue not found");

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
    expect(error.name).toBe("NotFoundError");
    expect(error.message).toBe("Queue not found");
  });

  it("keep the underlying cause", () => {
    const cause = new Error("unique violation");
    const error = new ConflictError("Slug already taken", { cause });

    expect(error.cause).toBe(cause);
  });
});
