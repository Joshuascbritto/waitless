"use client";

import { useEffect, useRef, useState } from "react";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "failed" | "done";

/**
 * Subscribes to a Server-Sent Events stream and keeps the latest `event`
 * payload. EventSource reconnects by itself after network drops; on every
 * (re)connect the server sends the full current state, so nothing is missed.
 *
 * - "failed": the server refused the stream (e.g. 404); EventSource won't retry.
 * - "done": `isFinal` returned true; the stream is closed on purpose.
 */
export function useEventStream<T>(
  url: string,
  event: string,
  isFinal?: (data: T) => boolean,
): { data: T | null; status: StreamStatus } {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const isFinalRef = useRef(isFinal);
  isFinalRef.current = isFinal;

  useEffect(() => {
    // Same origin, so the session cookie is sent without `withCredentials`.
    const source = new EventSource(url);
    setStatus("connecting");

    source.addEventListener(event, (message) => {
      const parsed = JSON.parse((message as MessageEvent<string>).data) as T;
      setData(parsed);
      if (isFinalRef.current?.(parsed)) {
        source.close();
        setStatus("done");
      } else {
        setStatus("open");
      }
    });
    source.onerror = () => {
      setStatus(source.readyState === EventSource.CLOSED ? "failed" : "reconnecting");
    };

    return () => source.close();
  }, [url, event]);

  return { data, status };
}
