import { ConflictError, NotFoundError, PROBLEM_CONTENT_TYPE } from "@waitless/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.ts";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false, readinessChecks: [] });
  app.get("/test/not-found", async () => {
    throw new NotFoundError("Queue not found");
  });
  app.get("/test/conflict", async () => {
    throw new ConflictError("Ticket is already being served");
  });
  app.get("/test/bug", async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
  });
  app.post(
    "/test/validated",
    {
      schema: {
        body: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
    },
    async () => ({ ok: true }),
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("problem+json error handler", () => {
  it("maps a DomainError to its status, type and message", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/not-found",
      headers: { "x-request-id": "req-1" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain(PROBLEM_CONTENT_TYPE);
    expect(res.json()).toEqual({
      type: "urn:waitless:problem:not_found",
      title: "Not Found",
      status: 404,
      detail: "Queue not found",
      requestId: "req-1",
    });
  });

  it("maps a ConflictError to 409", async () => {
    const res = await app.inject({ method: "GET", url: "/test/conflict" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: "urn:waitless:problem:conflict", status: 409 });
  });

  it("maps schema validation failures to 400", async () => {
    const res = await app.inject({ method: "POST", url: "/test/validated", payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain(PROBLEM_CONTENT_TYPE);
    expect(res.json()).toMatchObject({ type: "about:blank", title: "Bad Request", status: 400 });
  });

  it("maps malformed JSON to 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/validated",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: 400 });
  });

  it("hides internals of unexpected errors", async () => {
    const res = await app.inject({ method: "GET", url: "/test/bug" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ type: "about:blank", title: "Internal Server Error" });
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("10.0.0.5");
  });

  it("answers unknown routes with a 404 problem", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain(PROBLEM_CONTENT_TYPE);
    expect(res.json()).toMatchObject({ type: "about:blank", status: 404 });
  });
});
