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
 * TODO(you): implement the three cases. Tests in error-handler.test.ts describe the contract.
 *   1. DomainError (from @waitless/shared): use its status, `problemTypeFor(error.code)` as type,
 *      and its message as detail. Domain messages are written to be shown to users.
 *   2. Fastify errors (`isFastifyHttpError`) with a 4xx statusCode: the client sent something
 *      wrong (bad JSON, failed validation). Decide how much of Fastify's message to expose.
 *   3. Anything else, and Fastify errors with 5xx: a bug or an outage. What may the client see?
 *      Remember the message could contain SQL, hostnames or secrets.
 *   Use `type: "about:blank"` for non-domain problems, and `httpTitle(status)` for titles.
 */
export function toProblem(error: unknown): ProblemDetails {
  void error;
  void DomainError;
  void problemTypeFor;
  // Safe default until the mapping above is written: reveal nothing.
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
