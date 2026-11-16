import type { FastifyRequest, FastifyServerOptions } from "fastify";

/**
 * Ticket URLs carry the customer's capability token (`/t/{token}`), and
 * CLAUDE.md says tokens are never logged. Mask that path segment.
 */
export function redactUrl(url: string): string {
  return url.replace(/\/t\/[^/?#]+/g, "/t/[redacted]");
}

/** pino options for the API. Request logs keep method/url/ip, with the url redacted. */
export function loggerOptions(level: string): NonNullable<FastifyServerOptions["logger"]> {
  return {
    level,
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: redactUrl(request.url),
          remoteAddress: request.ip,
        };
      },
    },
  };
}
