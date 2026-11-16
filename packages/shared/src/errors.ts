/**
 * Base class for expected failures that mean something in the domain
 * ("ticket not found", "invalid transition"), as opposed to bugs.
 *
 * Domain code throws these without knowing about HTTP. The API's error
 * handler maps them to `application/problem+json`: `status` becomes the
 * HTTP status and `code` becomes the problem `type`.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  override readonly code = "not_found";
  override readonly status = 404;
}

export class ConflictError extends DomainError {
  override readonly code = "conflict";
  override readonly status = 409;
}

export class UnauthorizedError extends DomainError {
  override readonly code = "unauthorized";
  override readonly status = 401;
}

export class ForbiddenError extends DomainError {
  override readonly code = "forbidden";
  override readonly status = 403;
}
