import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiBackend } from "./api-backend";
import type { MarkdownFileChangeEvent } from "./storage";

// Why: a browser allows 6 connections per server, shared by every tab, and an
// open event stream keeps one until the tab closes. Three Roughdraft tabs with
// two streams each left nothing for the save request of a fourth, which then
// showed "Saving" forever. A tab must watch its file with short requests only.
describe("ApiBackend.watchMarkdownFile", () => {
  const originalFetch = global.fetch;
  const originalEventSource = global.EventSource;
  let versions: Array<string | null>;
  let fetchedUrls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    fetchedUrls = [];
    versions = ["v1"];
    global.EventSource = vi.fn(() => {
      throw new Error("a tab must not hold an event stream open");
    }) as unknown as typeof EventSource;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      const version = versions.length > 1 ? versions.shift() : versions[0];
      return new Response(
        JSON.stringify({
          path: "draft.md",
          exists: version !== null,
          version,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
  });

  function backend() {
    return new ApiBackend({
      kind: "api",
      label: "Local files",
      detail: "/work",
      projectPath: "/work",
    } as ConstructorParameters<typeof ApiBackend>[0]);
  }

  it("reports a change when the file version moves on", async () => {
    const events: MarkdownFileChangeEvent[] = [];
    const stop = backend().watchMarkdownFile("draft.md", (event) =>
      events.push(event),
    );

    await vi.advanceTimersByTimeAsync(2_500);
    expect(events).toEqual([{ path: "draft.md", exists: true, version: "v1" }]);

    versions = ["v2"];
    await vi.advanceTimersByTimeAsync(1_500);
    expect(events.at(-1)).toEqual({
      path: "draft.md",
      exists: true,
      version: "v2",
    });
    expect(fetchedUrls.every((url) => url.includes("/version"))).toBe(true);

    stop();
  });

  it("stops polling once the watcher is stopped", async () => {
    const stop = backend().watchMarkdownFile("draft.md", () => {});
    await vi.advanceTimersByTimeAsync(1_500);
    stop();
    const requestsAfterStop = fetchedUrls.length;

    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchedUrls.length).toBe(requestsAfterStop);
  });

  it("keeps polling after a failed request", async () => {
    const events: MarkdownFileChangeEvent[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(
        new Response(
          JSON.stringify({ path: "draft.md", exists: true, version: "v9" }),
        ),
      ) as typeof fetch;

    const stop = backend().watchMarkdownFile("draft.md", (event) =>
      events.push(event),
    );
    await vi.advanceTimersByTimeAsync(3_000);

    expect(events.at(-1)?.version).toBe("v9");
    stop();
  });
});
