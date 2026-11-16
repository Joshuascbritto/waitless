import { z } from "zod";

/** Media type of every API error response (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/**
 * RFC 9457 Problem Details. Shared so the web app can parse API errors
 * with the same schema the API uses to produce them.
 * Extension members (e.g. `requestId`) are allowed, as the RFC permits.
 */
export const ProblemDetailsSchema = z.looseObject({
  /** URI reference identifying the problem type: "about:blank" or "urn:waitless:problem:<code>". */
  type: z.string().min(1),
  /** Short, human-readable summary of the problem type. */
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  /** Explanation specific to this occurrence. Never contains secrets or internals. */
  detail: z.string().optional(),
  /** Correlates the response with server logs. */
  requestId: z.string().optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/**
 * Problem type URI for a domain error code. A URN is a valid URI and doesn't
 * pretend there is a documentation page at some domain.
 */
export function problemTypeFor(code: string): string {
  return `urn:waitless:problem:${code}`;
}
