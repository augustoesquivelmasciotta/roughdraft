import { describe, expect, it } from "vitest";
import {
  MAX_REVIEW_POLL_SECONDS,
  ReviewWatchConnectionLostError,
  waitForReviewEvents,
} from "./review-watch";

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
    | { timedOut: true; nextSequence: number; instanceId?: string }
    | { events: unknown[]; nextSequence: number; instanceId?: string }
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

describe("waitForReviewEvents connection loss", () => {
  it("reports a lost server as ReviewWatchConnectionLostError after the failure window", async () => {
    const server = scriptedServer(Array.from({ length: 50 }, () => "reset"));
    const lost: string[] = [];

    const failure = waitForReviewEvents({
      fetchImpl: server.fetchImpl,
      serverUrl: "http://localhost:7480",
      target,
      failureWindowMs: 5_000,
      onConnectionLost: () => lost.push("lost"),
      now: server.now,
      sleep: server.sleep,
    });

    await expect(failure).rejects.toBeInstanceOf(
      ReviewWatchConnectionLostError,
    );
    expect(lost).toEqual(["lost"]);
    // 1 s + 2 s + 3 s of backoff passes a 5 s window after four polls.
    expect(server.bodies).toHaveLength(4);
  });

  it("tells the caller when the server answers again", async () => {
    const server = scriptedServer([
      { timedOut: true, nextSequence: 1 },
      "reset",
      "reset",
      { events: [{ sequence: 1 }], nextSequence: 2 },
    ]);
    const calls: string[] = [];

    await waitForReviewEvents({
      fetchImpl: server.fetchImpl,
      serverUrl: "http://localhost:7480",
      target,
      onConnectionLost: () => calls.push("lost"),
      onReconnected: () => calls.push("back"),
      now: server.now,
      sleep: server.sleep,
    });

    expect(calls).toEqual(["lost", "back"]);
  });
});

describe("waitForReviewEvents across a server restart", () => {
  it("asks the restarted server at once and replays everything it has seen", async () => {
    const server = scriptedServer([
      { timedOut: true, nextSequence: 6, instanceId: "first" },
      "reset",
      // The quick poll after the reconnect, answered by the new server.
      { timedOut: true, nextSequence: 1, instanceId: "second" },
      { events: [{ sequence: 1 }], nextSequence: 2, instanceId: "second" },
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
      5,
      5,
      0,
    ]);
    expect(server.bodies[2]?.timeoutSeconds).toBe(0);
  });

  it("does not return events the stale cursor let through on the new server", async () => {
    const server = scriptedServer([
      { timedOut: true, nextSequence: 2, instanceId: "first" },
      "reset",
      { events: [{ sequence: 3 }], nextSequence: 4, instanceId: "second" },
      {
        events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
        nextSequence: 4,
        instanceId: "second",
      },
    ]);

    const payload = await waitForReviewEvents({
      fetchImpl: server.fetchImpl,
      serverUrl: "http://localhost:7480",
      target,
      now: server.now,
      sleep: server.sleep,
    });

    expect(payload.events).toEqual([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
    ]);
  });

  it("keeps its cursor when the same server answers again", async () => {
    const server = scriptedServer([
      { timedOut: true, nextSequence: 4, instanceId: "same" },
      "reset",
      { timedOut: true, nextSequence: 4, instanceId: "same" },
      { events: [{ sequence: 4 }], nextSequence: 5, instanceId: "same" },
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
      3,
    ]);
    expect(server.bodies[2]?.timeoutSeconds).toBe(0);
    expect(Number(server.bodies[3]?.timeoutSeconds)).toBeGreaterThan(0);
  });

  it("retries a lost server at least every three seconds", async () => {
    const server = scriptedServer([
      { timedOut: true, nextSequence: 1 },
      ...Array.from({ length: 8 }, () => "reset" as const),
      { events: [{ sequence: 1 }], nextSequence: 2 },
    ]);
    const delays: number[] = [];

    await waitForReviewEvents({
      fetchImpl: server.fetchImpl,
      serverUrl: "http://localhost:7480",
      target,
      now: server.now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        await server.sleep(milliseconds);
      },
    });

    expect(Math.max(...delays)).toBeLessThanOrEqual(3_000);
  });
});
