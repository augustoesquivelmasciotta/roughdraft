import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchOpenRequests } from "./open-requests";

// Same reason as api-backend.test.ts: no tab may hold an event stream open.
describe("watchOpenRequests", () => {
  const originalFetch = global.fetch;
  const originalEventSource = global.EventSource;
  let queued: Array<{ path: string; url: string }>;
  let fetchedUrls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    queued = [];
    fetchedUrls = [];
    global.EventSource = vi.fn(() => {
      throw new Error("a tab must not hold an event stream open");
    }) as unknown as typeof EventSource;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      const requests = queued;
      queued = [];
      return new Response(JSON.stringify({ requests }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
  });

  it("hands each queued request to the listener once", async () => {
    const received: string[] = [];
    const stop = watchOpenRequests("/work/draft.md", (request) =>
      received.push(request.url),
    );

    await vi.advanceTimersByTimeAsync(500);
    queued = [{ path: "/work/draft.md", url: "http://localhost:7373/?a=1" }];
    await vi.advanceTimersByTimeAsync(2_500);

    expect(received).toEqual(["http://localhost:7373/?a=1"]);
    stop();
  });

  it("identifies the tab and the document it shows", async () => {
    const stop = watchOpenRequests("/work/draft.md", () => {});
    await vi.advanceTimersByTimeAsync(100);

    const url = new URL(fetchedUrls[0], "http://localhost");
    expect(url.pathname).toBe("/api/open-requests/poll");
    expect(url.searchParams.get("path")).toBe("/work/draft.md");
    expect(url.searchParams.get("clientId")).toBeTruthy();
    stop();
  });

  it("stops polling once stopped", async () => {
    const stop = watchOpenRequests("/work/draft.md", () => {});
    await vi.advanceTimersByTimeAsync(2_500);
    stop();
    const requestsAfterStop = fetchedUrls.length;

    await vi.advanceTimersByTimeAsync(20_000);

    expect(fetchedUrls.length).toBe(requestsAfterStop);
  });
});
