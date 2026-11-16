/**
 * Server-Sent Events (SPEC §7, ADR-0002): one long-lived HTTP response per
 * client, server → client only. Plain HTTP, so it passes proxies and ingress
 * without upgrade configuration and uses the normal session cookie.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export const HEARTBEAT_MS = 15_000;
/** Tells EventSource how long to wait before reconnecting. */
const RETRY_MS = 3_000;

/** One SSE message. JSON.stringify never emits raw newlines, so `data` is always one line. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SseConnection {
  readonly ip: string;
  readonly #reply: FastifyReply;
  readonly #heartbeat: NodeJS.Timeout;
  readonly #onClose: Array<() => void> = [];
  #closed = false;

  constructor(request: FastifyRequest, reply: FastifyReply, heartbeatMs = HEARTBEAT_MS) {
    this.ip = request.ip;
    this.#reply = reply;

    // Take the socket over from Fastify; keep the headers it already set
    // (x-request-id, helmet), plus what streaming needs.
    reply.hijack();
    const inherited = Object.fromEntries(
      Object.entries(reply.getHeaders()).filter(
        (entry): entry is [string, string | number | string[]] => entry[1] !== undefined,
      ),
    );
    reply.raw.writeHead(200, {
      ...inherited,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx/ingress: don't buffer this response.
      "x-accel-buffering": "no",
    });
    reply.raw.write(`retry: ${RETRY_MS}\n\n`);

    // A comment line every 15 s keeps proxies from closing an idle connection
    // and lets the server notice dead clients.
    this.#heartbeat = setInterval(() => this.#write(": ping\n\n"), heartbeatMs);
    request.raw.on("close", () => this.close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(event: string, data: unknown): void {
    this.#write(formatSseEvent(event, data));
  }

  onClose(fn: () => void): void {
    if (this.#closed) fn();
    else this.#onClose.push(fn);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.#reply.raw.end();
    for (const fn of this.#onClose) fn();
  }

  #write(chunk: string): void {
    if (!this.#closed) this.#reply.raw.write(chunk);
  }
}

/** Tracks open streams: connection gauge, per-IP cap, and closing everything on shutdown. */
export class SseRegistry {
  readonly #connections = new Set<SseConnection>();
  readonly #perIp = new Map<string, number>();

  get size(): number {
    return this.#connections.size;
  }

  connectionsFrom(ip: string): number {
    return this.#perIp.get(ip) ?? 0;
  }

  add(connection: SseConnection): void {
    this.#connections.add(connection);
    this.#perIp.set(connection.ip, this.connectionsFrom(connection.ip) + 1);
    connection.onClose(() => {
      this.#connections.delete(connection);
      const left = this.connectionsFrom(connection.ip) - 1;
      if (left > 0) this.#perIp.set(connection.ip, left);
      else this.#perIp.delete(connection.ip);
    });
  }

  /** Ends every stream so the server can shut down (otherwise close() waits forever). */
  closeAll(): void {
    for (const connection of [...this.#connections]) {
      connection.close();
    }
  }
}
