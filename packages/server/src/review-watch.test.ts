import { describe, expect, it } from "vitest";
import { MAX_REVIEW_POLL_SECONDS, waitForReviewEvents } from "./review-watch";

const target = {
  projectPath: "/project",
  path: "draft.md",
  batchWindowSeconds: 0,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function connectionReset(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  });
}

/**
 * Scripted server: each call consumes the next scripted answer and records
 * the request body. Time only moves through the injected clock.
 */
function scriptedServer(
  answers: Array<
    | { timedOut: true; nextSequence: number }
    | { events: unknown[]; nextSequence: number }
    | "reset"
    | number
  >,
) {
  const bodies: Array<Record<string, unknown>> = [];
  let clock = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const answer = answers.shift();
    if (answer === undefined) throw new Error("Unexpected extra request");
    if (answer === "reset") throw connectionReset();
    if (typeof answer === "number") return jsonResponse({}, answer);
    if ("timedOut" in answer) {
      clock += Number(body.timeoutSeconds) * 1000;
      return jsonResponse({ events: [], ...answer });
    }
    return jsonResponse({ timedOut: false, ...answer });
  };

  return {
    bodies,
    fetchImpl,
    now: () => clock,
    sleep: async (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

describe("waitForReviewEvents", () => {
  it("keeps waiting across a dropped connection and resumes from the last sequence", async () => {
    const server = scriptedServer([
      { timedOut: true, nextSequence: 4 },
      "reset",
      { events: [{ sequence: 4 }], nextSequence: 5 },
    ]);

    const payload = await waitForReviewEvents({
      fetchImpl: server.fetchImpl,
      serverUrl: "http://localhost:7480",
      target,
      now: server.now,
      sleep: server.sleep,
    });

    expect(payload.events).toEqual([{ sequence: 4 }]);
    expect(server.bodies.map((body) => body.afterSequence)).toEqual([
      undefined,
      3,
      3,
    ]);
    expect(
      server.bodies.every(
        (body) => Number(body.timeoutSeconds) <= MAX_REVIEW_POLL_SECONDS,
      ),
    ).toBe(true);
  });

  it("replays from the start when the server restarted and counts sequences again", async () => {
    const server = scriptedServer([
      { timedOut: true, nextSequence: 9 },
      // After a restart the server's next sequence is lower than ours.
      { timedOut: true, nextSequence: 2 },
      { events: [{ sequence: 1 }], nextSequence: 2 },
    ]);

    const payload = await waitForReviewEvents({
      fetchImpl: server.fetchImpl,
      serverUrl: "http://localhost:7480",
      target,
      now: server.now,
      sleep: server.sleep,
    });

    expect(payload.events).toEqual([{ sequence: 1 }]);
    expect(server.bodies.map((body) => body.afterSequence)).toEqual([
      undefined,
      8,
      0,
    ]);
  });

  it("reports an HTTP error instead of retrying it", async () => {
    const server = scriptedServer([404]);

    await expect(
      waitForReviewEvents({
        fetchImpl: server.fetchImpl,
        serverUrl: "http://localhost:7480",
        target,
        now: server.now,
        sleep: server.sleep,
      }),
    ).rejects.toThrow("Failed to watch review events: 404");
    expect(server.bodies).toHaveLength(1);
  });

  it("gives up when the server stays unreachable", async () => {
    const server = scriptedServer(Array.from({ length: 50 }, () => "reset"));

    await expect(
      waitForReviewEvents({
        fetchImpl: server.fetchImpl,
        serverUrl: "http://localhost:7480",
        target,
        now: server.now,
        sleep: server.sleep,
      }),
    ).rejects.toThrow("fetch failed");
    expect(server.bodies.length).toBeGreaterThan(1);
    expect(server.bodies.length).toBeLessThan(50);
  });
});
