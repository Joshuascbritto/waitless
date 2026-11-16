import { type ProblemDetails, ProblemDetailsSchema } from "@waitless/shared";

/** An API error, carrying the RFC 9457 problem the API returned. */
export class ApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.problem = problem;
  }

  get status(): number {
    return this.problem.status;
  }
}

/**
 * Browser-side call to the API. Same origin (`/api/...`), so the session
 * cookie travels automatically and the browser adds the Origin header the
 * API's CSRF check expects.
 */
export async function apiRequest<T>(
  path: `/api/${string}`,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? null : JSON.stringify(init.body),
    credentials: "same-origin",
  });

  if (response.ok) {
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  throw new ApiError(await readProblem(response));
}

async function readProblem(response: Response): Promise<ProblemDetails> {
  const parsed = ProblemDetailsSchema.safeParse(await response.json().catch(() => null));
  if (parsed.success) {
    return parsed.data;
  }
  // Not a problem+json body (e.g. a proxy error page): fall back to the status.
  return { type: "about:blank", title: response.statusText || "Error", status: response.status };
}
