/**
 * Minimal SSE reader for tests: opens a real HTTP stream with fetch and
 * returns parsed events one at a time. (app.inject can't test streams: it
 * waits for the response to end, and an event stream never does.)
 */
export interface SseMessage {
  event: string;
  data: unknown;
}

export interface TestStream {
  status: number;
  /** Raw text received so far (comments and all), for assertions like heartbeats. */
  raw(): string;
  /** Resolves with the next event named `event`, skipping others. */
  next<T = unknown>(event: string, timeoutMs?: number): Promise<T>;
  close(): void;
}

export async function openStream(
  url: string,
  headers: Record<string, string> = {},
): Promise<TestStream> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let all = "";
  const pending: SseMessage[] = [];

  function drain(): void {
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
      if (event && data !== undefined) pending.push({ event, data: JSON.parse(data) });
      end = buffer.indexOf("\n\n");
    }
  }

  // One read in flight at a time. It may outlive a timed-out next() and then be
  // aborted by close(); the no-op catch keeps that from becoming an unhandled rejection.
  let inflight: Promise<void> | undefined;
  function readChunk(): Promise<void> {
    if (!reader) throw new Error("response has no body");
    inflight ??= reader
      .read()
      .then(({ value, done }) => {
        if (done) throw new Error("stream ended");
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        all += text;
        drain();
      })
      .finally(() => {
        inflight = undefined;
      });
    inflight.catch(() => {});
    return inflight;
  }

  return {
    status: response.status,
    raw: () => all,
    async next<T>(event: string, timeoutMs = 5_000): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = pending.findIndex((m) => m.event === event);
        if (index !== -1) {
          const [message] = pending.splice(index, 1);
          return message?.data as T;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out waiting for "${event}"`);
        await Promise.race([
          readChunk(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), left),
          ),
        ]);
      }
    },
    close: () => controller.abort(),
  };
}

/** Starts listening on a random local port and returns the base URL. */
export async function listen(app: {
  listen(opts: { port: number; host: string }): Promise<string>;
}): Promise<string> {
  return app.listen({ port: 0, host: "127.0.0.1" });
}
