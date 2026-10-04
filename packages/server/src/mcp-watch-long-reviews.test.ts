import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool } from "./mcp";

/*
 * Bug F, MCP side: roughdraft_watch_review_events sends one long-poll and
 * Node's fetch (undici) fails it with UND_ERR_HEADERS_TIMEOUT once response
 * headers take 300 s; the server also clamps any wait to 300 s.
 *
 * The fake server below only moves a fake clock while it holds a watch
 * request open, so long reviews run in milliseconds. A request it would hold
 * for 300 s or more fails the way Node's fetch fails in production.
 */

const UNDICI_HEADERS_TIMEOUT_MS = 300_000; // Node fetch default headersTimeout
const SERVER_MAX_WAIT_MS = 300_000; // clamp in normalizeWaitOptions (review-events.ts)
const MAX_LONG_POLL_SECONDS = 240; // contract: no watch request asks for more
const FAKE_SERVER_PORT = 47_731; // never dialed: every request goes to the fake fetch
const NEXT_SEQUENCE_BEFORE_REVIEW = 7; // server's nextSequence until Done Reviewing
const MAX_WATCH_REQUESTS = 1_000; // runaway-polling guard

interface WatchRequestBody {
  timeoutSeconds?: unknown;
  fromNow?: unknown;
  afterSequence?: unknown;
}

type ToolOutcome = { result: unknown } | { crashed: string };

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function undiciHeadersTimeoutError(): TypeError {
  const cause = Object.assign(new Error("Headers Timeout Error"), {
    name: "HeadersTimeoutError",
    code: "UND_ERR_HEADERS_TIMEOUT",
  });
  return new TypeError("fetch failed", { cause });
}

async function settle(run: Promise<unknown>): Promise<ToolOutcome> {
  try {
    return { result: await run };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      error instanceof Error &&
      error.cause &&
      typeof error.cause === "object" &&
      "code" in error.cause
        ? ` (${String(error.cause.code)})`
        : "";
    return { crashed: `${message}${cause}` };
  }
}

/**
 * A Roughdraft server whose reviewer clicks Done Reviewing
 * `reviewTakesSeconds` after the tool starts waiting (null: never).
 */
function createFakeReviewServer(options: {
  documentPath: string;
  reviewTakesSeconds: number | null;
  overallComment: string;
}) {
  const watchRequests: WatchRequestBody[] = [];
  const startedAt = Date.now();
  const reviewCompletedAt =
    options.reviewTakesSeconds === null
      ? Number.POSITIVE_INFINITY
      : startedAt + options.reviewTakesSeconds * 1000;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    if (
      url.port !== String(FAKE_SERVER_PORT) ||
      url.pathname !== "/api/review-events/watch"
    ) {
      throw new Error(`Unexpected request to fake Roughdraft: ${url}`);
    }

    const body = (
      typeof init?.body === "string"
        ? JSON.parse(init.body)
        : input instanceof Request
          ? await input.json()
          : {}
    ) as WatchRequestBody;
    watchRequests.push(body);
    if (watchRequests.length > MAX_WATCH_REQUESTS) {
      throw new Error(`Runaway polling: ${watchRequests.length} requests.`);
    }

    const now = Date.now();
    // Without timeoutSeconds the server holds the request until the review.
    const serverWaitMs =
      typeof body.timeoutSeconds === "number"
        ? Math.min(Math.max(body.timeoutSeconds * 1000, 0), SERVER_MAX_WAIT_MS)
        : Number.POSITIVE_INFINITY;
    const respondsAt = Math.min(
      now + serverWaitMs,
      Math.max(now, reviewCompletedAt),
    );

    if (respondsAt - now >= UNDICI_HEADERS_TIMEOUT_MS) {
      vi.advanceTimersByTime(UNDICI_HEADERS_TIMEOUT_MS);
      throw undiciHeadersTimeoutError();
    }

    vi.advanceTimersByTime(respondsAt - now);
    if (respondsAt < reviewCompletedAt) {
      return jsonResponse({
        events: [],
        timedOut: true,
        nextSequence: NEXT_SEQUENCE_BEFORE_REVIEW,
      });
    }

    return jsonResponse({
      events: [
        {
          type: "review.completed",
          sequence: NEXT_SEQUENCE_BEFORE_REVIEW,
          createdAt: new Date(reviewCompletedAt).toISOString(),
          documentPath: options.documentPath,
          projectPath: path.dirname(options.documentPath),
          relativePath: path.basename(options.documentPath),
          version: "fake-version",
          summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 },
          overallComment: options.overallComment,
        },
      ],
      timedOut: false,
      nextSequence: NEXT_SEQUENCE_BEFORE_REVIEW + 1,
    });
  };

  return {
    fetchImpl,
    watchRequests,
    elapsedSeconds: () => (Date.now() - startedAt) / 1000,
  };
}

function expectBoundedLongPolls(requests: WatchRequestBody[]) {
  expect(requests.length, "watch requests sent").toBeGreaterThan(0);
  for (const [index, request] of requests.entries()) {
    const label = `watch request #${index + 1} timeoutSeconds`;
    expect(request.timeoutSeconds, label).toBeTypeOf("number");
    expect(request.timeoutSeconds as number, label).toBeGreaterThan(0);
    expect(request.timeoutSeconds as number, label).toBeLessThanOrEqual(
      MAX_LONG_POLL_SECONDS,
    );
  }
}

function expectRepollsContinueFromLastSequence(requests: WatchRequestBody[]) {
  expect(requests.length, "watch requests sent").toBeGreaterThan(1);
  for (const [index, request] of requests.slice(1).entries()) {
    expect(request, `watch request #${index + 2}`).toMatchObject({
      fromNow: false,
      afterSequence: NEXT_SEQUENCE_BEFORE_REVIEW - 1,
    });
  }
}

describe("roughdraft_watch_review_events on reviews longer than one long-poll (Bug F)", () => {
  const overallComment = "Please prioritize the CLI contract.";
  let tempDir: string;
  let projectDir: string;
  let documentPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-long-"));
    projectDir = path.join(tempDir, "project");
    documentPath = path.join(projectDir, "draft.md");
    const stateFile = path.join(tempDir, "state", "server.json");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        url: `http://localhost:${FAKE_SERVER_PORT}`,
        port: FAKE_SERVER_PORT,
      }),
    );
    env = { ROUGHDRAFT_STATE_FILE: stateFile };
    // Fake only the clocks; real timers keep the tool's own plumbing intact.
    vi.useFakeTimers({ toFake: ["Date", "performance", "hrtime"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("without timeoutSeconds, polls with bounded requests until a 9-minute review completes", async () => {
    // With 240 s polls: two timed-out polls, then the event on the third.
    const fake = createFakeReviewServer({
      documentPath,
      reviewTakesSeconds: 9 * 60,
      overallComment,
    });

    const outcome = await settle(
      callTool(
        "roughdraft_watch_review_events",
        { documentPath, projectPath: projectDir },
        env,
        fake.fetchImpl,
      ),
    );

    expect
      .soft(outcome, "a review longer than 5 minutes must not end the wait")
      .toMatchObject({
        result: {
          timedOut: false,
          events: [
            {
              type: "review.completed",
              sequence: NEXT_SEQUENCE_BEFORE_REVIEW,
              documentPath,
              overallComment,
            },
          ],
        },
      });
    expectBoundedLongPolls(fake.watchRequests);
    expect(fake.watchRequests[0]).toMatchObject({ fromNow: true });
    expectRepollsContinueFromLastSequence(fake.watchRequests);
    expect(fake.elapsedSeconds()).toBe(9 * 60);
  });

  it("with timeoutSeconds 600, polls for the full 600 s and then reports the timeout", async () => {
    const fake = createFakeReviewServer({
      documentPath,
      reviewTakesSeconds: null,
      overallComment,
    });

    const outcome = await settle(
      callTool(
        "roughdraft_watch_review_events",
        { documentPath, projectPath: projectDir, timeoutSeconds: 600 },
        env,
        fake.fetchImpl,
      ),
    );

    expect
      .soft(outcome, "timeoutSeconds 600 must wait 600 s, not die at 300 s")
      .toMatchObject({ result: { timedOut: true, events: [] } });
    expectBoundedLongPolls(fake.watchRequests);
    expectRepollsContinueFromLastSequence(fake.watchRequests);
    expect(fake.elapsedSeconds()).toBeCloseTo(600, 3);
  });
});
