/**
 * Postgres SQLSTATE of a failed query. Drizzle wraps driver errors
 * (DrizzleQueryError), so the code may be on the error or on its cause.
 */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = current.cause;
  }
  return undefined;
}

/** 23505: a unique constraint rejected the row (duplicate email, slug…). */
export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === "23505";
}
