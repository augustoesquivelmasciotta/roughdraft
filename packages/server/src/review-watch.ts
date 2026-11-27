/**
 * Waiting for "Done Reviewing" without a single never-ending request.
 *
 * Node's fetch (undici) gives up when response headers take longer than
 * 300 s, and the server caps any wait at 300 s. Long reviews are therefore
 * waited on with a series of bounded long-polls: each one asks the server to
 * answer within `MAX_REVIEW_POLL_SECONDS`, and the next one continues from the
 * event sequence the previous one reported, so no event is missed between
 * polls. Transient connection failures (for example a server restart) are
 * retried for a while instead of ending the wait.
 */

/** Longest single wait, safely below undici's 300 s headers timeout. */
export const MAX_REVIEW_POLL_SECONDS = 240;

/** Extra time a poll may take before the client gives up on it. */
const POLL_GRACE_SECONDS = 30;

/** Backoff between retries after a failed poll; the last delay repeats. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** Give up after this long without a successful poll, unless told otherwise. */
const DEFAULT_FAILURE_WINDOW_MS = 120_000;

export interface ReviewWatchTarget {
  projectPath: string;
  path: string;
  batchWindowSeconds: number;
}

export interface ReviewWatchPayload {
  events?: unknown[];
  timedOut?: boolean;
  nextSequence?: number;
  [key: string]: unknown;
}

export interface WaitForReviewEventsOptions {
  fetchImpl: typeof fetch;
  serverUrl: string | URL;
  target: ReviewWatchTarget;
  /** Overall wait in seconds; omitted means wait until the review is done. */
  timeoutSeconds?: number;
  /** Start from events that already happened after this sequence. */
  afterSequence?: number;
  /** Ignore events that happened before the wait started (default). */
  fromNow?: boolean;
  headers?: Record<string, string>;
  /** How long the server may stay unreachable before the wait gives up. */
  failureWindowMs?: number;
  /** Called once when a poll first fails to reach the server. */
  onConnectionLost?: () => void;
  /** Called when a poll succeeds again after a lost connection. */
  onReconnected?: () => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

class ReviewWatchHttpError extends Error {}

/**
 * The server stopped answering mid-wait and did not come back within the
 * failure window. Callers report it as `disconnected` instead of crashing.
 */
export class ReviewWatchConnectionLostError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ReviewWatchConnectionLostError";
  }
}

export async function waitForReviewEvents(
  options: WaitForReviewEventsOptions,
): Promise<ReviewWatchPayload> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline =
    options.timeoutSeconds === undefined
      ? null
      : now() + options.timeoutSeconds * 1000;
  let fromNow = options.fromNow ?? true;
  let afterSequence = options.afterSequence ?? 0;
  let failingSince: number | null = null;
  let failures = 0;
  const failureWindowMs = options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;

  while (true) {
    const remainingSeconds =
      deadline === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, (deadline - now()) / 1000);
    const pollSeconds = Math.min(MAX_REVIEW_POLL_SECONDS, remainingSeconds);
    const body = {
      ...options.target,
      timeoutSeconds: pollSeconds,
      fromNow,
      ...(fromNow ? {} : { afterSequence }),
    };

    let payload: ReviewWatchPayload;
    try {
      const response = await options.fetchImpl(
        new URL("/api/review-events/watch", options.serverUrl),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...options.headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(
            (pollSeconds + POLL_GRACE_SECONDS) * 1000,
          ),
        },
      );
      if (!response.ok) {
        throw new ReviewWatchHttpError(
          `Failed to watch review events: ${response.status}`,
        );
      }
      payload = (await response.json()) as ReviewWatchPayload;
    } catch (error) {
      // An HTTP error status is an answer from the server, not a lost
      // connection: report it instead of retrying.
      if (error instanceof ReviewWatchHttpError) throw error;

      if (failingSince === null) {
        failingSince = now();
        options.onConnectionLost?.();
      }
      const deadlinePassed = deadline !== null && now() >= deadline;
      if (deadlinePassed || now() - failingSince >= failureWindowMs) {
        throw new ReviewWatchConnectionLostError(error);
      }

      const delay =
        RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] ??
        1_000;
      failures += 1;
      await sleep(delay);
      continue;
    }

    if (failingSince !== null) options.onReconnected?.();
    failingSince = null;
    failures = 0;

    if (!payload.timedOut) return payload;
    if (deadline !== null && now() >= deadline) return payload;

    if (typeof payload.nextSequence === "number") {
      const latestSequence = payload.nextSequence - 1;
      // A server that restarted counts events from 1 again: replay
      // everything it has seen since, instead of skipping those events.
      afterSequence =
        !fromNow && latestSequence < afterSequence ? 0 : latestSequence;
      fromNow = false;
    }
  }
}
