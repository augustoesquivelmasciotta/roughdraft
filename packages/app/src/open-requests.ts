export interface OpenRequest {
  path: string;
  url: string;
}

const POLL_INTERVAL_MS = 2_000;

/**
 * Listens for "open this document" requests from the CLI by polling.
 *
 * Why not an event stream: a browser allows 6 connections per server, shared
 * by every tab, and a stream keeps one for as long as the tab lives. A few
 * open tabs used them all, and a later save request waited forever.
 */
export function watchOpenRequests(
  documentPath: string | null,
  onRequest: (request: OpenRequest) => void,
): () => void {
  const clientId =
    globalThis.crypto?.randomUUID?.() ??
    `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const poll = async () => {
    try {
      const url = new URL("/api/open-requests/poll", window.location.origin);
      url.searchParams.set("clientId", clientId);
      if (documentPath) {
        url.searchParams.set("path", documentPath);
      }

      const res = await fetch(`${url.pathname}${url.search}`);
      if (res.ok) {
        const payload = (await res.json()) as { requests?: unknown };
        const requests = Array.isArray(payload.requests)
          ? (payload.requests as OpenRequest[])
          : [];
        if (!stopped) {
          for (const request of requests) {
            onRequest(request);
          }
        }
      }
    } catch (error) {
      console.error("Failed to poll for Roughdraft open requests:", error);
    }

    if (!stopped) {
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  void poll();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
