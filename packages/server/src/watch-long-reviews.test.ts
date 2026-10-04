import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliDependencies, runCli } from "./cli";

/*
 * Bug F: `roughdraft open <file>` and `roughdraft watch <file>` crash with
 * UND_ERR_HEADERS_TIMEOUT once a review takes longer than five minutes. The
 * CLI waits on a single long-poll and Node's fetch (undici) gives up when
 * response headers take 300 s; the server also clamps any wait to 300 s.
 *
 * These tests drive the real CLI against a fake Roughdraft server. Time only
 * moves on a fake clock while the fake holds a watch request open, so a
 * 13-minute review runs in milliseconds. The fake also plays the transport:
 * a request it would hold for 300 s or more fails the way Node's fetch fails
 * in production.
 */

const UNDICI_HEADERS_TIMEOUT_MS = 300_000; // Node fetch default headersTimeout
const SERVER_MAX_WAIT_MS = 300_000; // clamp in normalizeWaitOptions (review-events.ts)
const MAX_LONG_POLL_SECONDS = 240; // contract: no watch request asks for more
const FAKE_SERVER_PORT = 47_731; // never dialed: every request goes to the fake fetch
const NEXT_SEQUENCE_BEFORE_REVIEW = 7; // server's nextSequence until Done Reviewing
const MAX_WATCH_REQUESTS = 1_000; // runaway-polling guard

const serverRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

interface WatchRequestBody {
  projectPath?: unknown;
  path?: unknown;
  timeoutSeconds?: unknown;
  batchWindowSeconds?: unknown;
  fromNow?: unknown;
  afterSequence?: unknown;
}

type RunOutcome = { exitCode: number } | { crashed: string };

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

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

async function requestJsonBody(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<WatchRequestBody> {
  if (typeof init?.body === "string") {
    return JSON.parse(init.body) as WatchRequestBody;
  }
  if (input instanceof Request) {
    return (await input.json()) as WatchRequestBody;
  }
  return {};
}

async function settle(run: Promise<number>): Promise<RunOutcome> {
  try {
    return { exitCode: await run };
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
 * `reviewTakesSeconds` after the CLI starts waiting (null: never).
 */
function createFakeRoughdraftServer(options: {
  projectDir: string;
  documentPath: string;
  reviewTakesSeconds: number | null;
}) {
  const watchRequests: WatchRequestBody[] = [];
  const startedAt = Date.now();
  const reviewCompletedAt =
    options.reviewTakesSeconds === null
      ? Number.POSITIVE_INFINITY
      : startedAt + options.reviewTakesSeconds * 1000;

  function holdWatchRequest(body: WatchRequestBody): Response {
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
          projectPath: options.projectDir,
          relativePath: path.basename(options.documentPath),
          version: "fake-version",
          summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 },
        },
      ],
      timedOut: false,
      nextSequence: NEXT_SEQUENCE_BEFORE_REVIEW + 1,
    });
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.port !== String(FAKE_SERVER_PORT)) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${url.host}`), {
          code: "ECONNREFUSED",
        }),
      });
    }

    switch (url.pathname) {
      case "/api/status":
        return jsonResponse({
          backend: "local-files",
          pid: 4242,
          port: FAKE_SERVER_PORT,
          projectDir: options.projectDir,
          serverRoot,
        });
      case "/api/open-request":
        return jsonResponse({ delivered: false });
      case "/api/review-events/watch":
        return holdWatchRequest(await requestJsonBody(input, init));
      default:
        throw new Error(`Unexpected request to fake Roughdraft: ${url}`);
    }
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

describe("CLI waits on reviews longer than one long-poll (Bug F)", () => {
  let tempDir: string;
  let projectDir: string;
  let documentPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-long-watch-"));
    projectDir = path.join(tempDir, "project");
    documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
    // Fake only the clocks; real timers keep the CLI's own plumbing intact.
    vi.useFakeTimers({ toFake: ["Date", "performance", "hrtime"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createCli(fake: ReturnType<typeof createFakeRoughdraftServer>) {
    const logs: string[] = [];
    const errors: string[] = [];
    const openedUrls: string[] = [];
    const deps = createCliDependencies({
      env: {
        ROUGHDRAFT_STATE_DIR: path.join(tempDir, "state"),
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(tempDir, "no-dev.json"),
        ROUGHDRAFT_PORT: String(FAKE_SERVER_PORT),
      },
      cwd: projectDir,
      fetchImpl: fake.fetchImpl,
      findAvailablePortImpl: async () => {
        throw new Error("The CLI should reuse the fake server.");
      },
      sleepImpl: async () => {},
      spawnServerProcess: () => {
        throw new Error("The CLI should reuse the fake server.");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      openUrl: (url) => {
        openedUrls.push(url);
        return "disabled";
      },
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0.1.10",
        latestVersion: "0.1.10",
        updateAvailable: false,
        updateCommand: "npm i -g roughdraft@latest",
      }),
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    });
    return { deps, logs, errors, openedUrls };
  }

  it("watch without --timeout outlasts a 13-minute review with bounded polls", async () => {
    // With 240 s polls: three timed-out polls, then the event on the fourth.
    const fake = createFakeRoughdraftServer({
      projectDir,
      documentPath,
      reviewTakesSeconds: 13 * 60,
    });
    const cli = createCli(fake);

    const outcome = await settle(runCli(["watch", documentPath], cli.deps));

    expect
      .soft(outcome, "a review longer than 5 minutes must not end the wait")
      .toEqual({ exitCode: 0 });
    expectBoundedLongPolls(fake.watchRequests);
    expect(fake.watchRequests[0]).toMatchObject({
      projectPath: projectDir,
      path: "draft.md",
      fromNow: true,
    });
    expectRepollsContinueFromLastSequence(fake.watchRequests);
    expect(fake.elapsedSeconds()).toBe(13 * 60);
    expect(cli.logs).toEqual([
      `Review completed for ${documentPath}.`,
      "Received 1 event(s).",
    ]);
    expect(cli.errors).toEqual([]);
  });

  it("watch --json prints only the final review payload after timed-out polls", async () => {
    const fake = createFakeRoughdraftServer({
      projectDir,
      documentPath,
      reviewTakesSeconds: 13 * 60,
    });
    const cli = createCli(fake);

    const outcome = await settle(
      runCli(["watch", documentPath, "--json"], cli.deps),
    );

    expect.soft(outcome).toEqual({ exitCode: 0 });
    expectBoundedLongPolls(fake.watchRequests);
    expect(cli.logs).toHaveLength(1);
    expect(JSON.parse(cli.logs[0] ?? "null")).toMatchObject({
      timedOut: false,
      events: [
        {
          type: "review.completed",
          sequence: NEXT_SEQUENCE_BEFORE_REVIEW,
          documentPath,
        },
      ],
    });
  });

  it("open keeps waiting for Done Reviewing past five minutes", async () => {
    const fake = createFakeRoughdraftServer({
      projectDir,
      documentPath,
      reviewTakesSeconds: 7 * 60,
    });
    const cli = createCli(fake);

    const outcome = await settle(runCli(["open", documentPath], cli.deps));

    expect
      .soft(outcome, "a review longer than 5 minutes must not end the wait")
      .toEqual({ exitCode: 0 });
    expectBoundedLongPolls(fake.watchRequests);
    expectRepollsContinueFromLastSequence(fake.watchRequests);
    expect(cli.openedUrls).toHaveLength(1);
    expect(cli.logs).toContain("Waiting for Done Reviewing...");
    expect(cli.logs.slice(-2)).toEqual([
      `Review completed for ${documentPath}.`,
      "Received 1 event(s).",
    ]);
  });

  it("watch --timeout 600 keeps polling for the full 600 s, then exits 1", async () => {
    const fake = createFakeRoughdraftServer({
      projectDir,
      documentPath,
      reviewTakesSeconds: null,
    });
    const cli = createCli(fake);

    const outcome = await settle(
      runCli(["watch", documentPath, "--timeout", "600"], cli.deps),
    );

    expect
      .soft(outcome, "--timeout 600 must wait 600 s, not die at 300 s")
      .toEqual({ exitCode: 1 });
    expectBoundedLongPolls(fake.watchRequests);
    // e.g. 240, 240, 120: the last poll asks only for what is left.
    const requested = fake.watchRequests.map(
      (request) => request.timeoutSeconds as number,
    );
    const beforeLast = requested
      .slice(0, -1)
      .reduce((total, seconds) => total + seconds, 0);
    expect(requested.at(-1)).toBeCloseTo(600 - beforeLast, 3);
    expect(fake.elapsedSeconds()).toBeCloseTo(600, 3);
    expectRepollsContinueFromLastSequence(fake.watchRequests);
    expect(cli.logs).toEqual([
      `No review completed event received for ${documentPath}.`,
    ]);
  });
});
