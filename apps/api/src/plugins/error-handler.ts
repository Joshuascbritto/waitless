import { STATUS_CODES } from "node:http";
import {
  DomainError,
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  problemTypeFor,
} from "@waitless/shared";
import type { FastifyError, FastifyInstance } from "fastify";

/** Standard HTTP reason phrase, e.g. 404 → "Not Found". */
export function httpTitle(status: number): string {
  return STATUS_CODES[status] ?? "Error";
}

/** Errors Fastify raises itself (bad JSON, schema validation, body too large…) carry a statusCode. */
export function isFastifyHttpError(error: unknown): error is FastifyError & { statusCode: number } {
  return error instanceof Error && typeof (error as FastifyError).statusCode === "number";
}

/**
 * Maps any thrown value to an RFC 9457 problem. This is the error contract
 * every client of the API relies on.
 *
 * 1. DomainError: expected and written for users, so its message is the detail
 *    and its code becomes a stable, machine-readable `type`.
 * 2. Fastify 4xx (bad JSON, schema validation, payload too large): the message
 *    describes the client's own input ("body must have required property 'name'"),
 *    which helps them fix the request and leaks nothing about the server.
 * 3. Everything else, including Fastify 5xx: a bug or an outage. The message may
 *    hold SQL, hostnames or secrets, so the client gets only the status and the
 *    requestId to quote; the full error goes to the logs.
 */
export function toProblem(error: unknown): ProblemDetails {
  if (error instanceof DomainError) {
    return {
      type: problemTypeFor(error.code),
      title: httpTitle(error.status),
      status: error.status,
      detail: error.message,
    };
  }

  if (isFastifyHttpError(error) && error.statusCode >= 400 && error.statusCode < 500) {
    return {
      type: "about:blank",
      title: httpTitle(error.statusCode),
      status: error.statusCode,
      detail: error.message,
    };
  }

  return { type: "about:blank", title: httpTitle(500), status: 500 };
}

/** One place that turns every failure into `application/problem+json`. */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error);

    if (problem.status >= 500) {
      request.log.error({ err: error }, "request failed with a server error");
    } else {
      request.log.info({ err: error }, "request failed with a client error");
    }

    return reply
      .code(problem.status)
      .type(PROBLEM_CONTENT_TYPE)
      .send({ ...problem, requestId: request.id } satisfies ProblemDetails);
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send({
        type: "about:blank",
        title: httpTitle(404),
        status: 404,
        detail: "No route matches this method and path.",
        requestId: request.id,
      } satisfies ProblemDetails);
  });
}
