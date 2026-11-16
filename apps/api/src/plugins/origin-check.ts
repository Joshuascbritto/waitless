import { ForbiddenError } from "@waitless/shared";
import type { FastifyInstance } from "fastify";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense, layer 2 (layer 1 is SameSite=Lax on the session cookie).
 *
 * Browsers attach an Origin header to every cross-origin request and to every
 * same-origin request that isn't GET/HEAD; page scripts can't forge or remove it. A state-changing request
 * from any other site, or with no Origin at all, is refused. It's simpler than
 * CSRF tokens and holds because web and API share one origin (ADR-0007).
 */
export function registerOriginCheck(app: FastifyInstance, appOrigin: string): void {
  app.addHook("onRequest", async (request) => {
    if (SAFE_METHODS.has(request.method)) {
      return;
    }
    const origin = request.headers.origin;
    if (origin !== appOrigin) {
      throw new ForbiddenError(
        origin === undefined ? "Missing Origin header" : "Cross-origin request refused",
      );
    }
  });
}
