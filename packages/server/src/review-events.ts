import fs from "node:fs";
import path from "node:path";

export interface ReviewCompletedEventInput {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  version: string;
  summary: {
    comments: number;
    replies: number;
    suggestions: number;
    unresolved: number;
  };
  overallComment?: string;
}

export type ReviewDoneReason = "overall-comment" | "threads-cleared";

export interface ReviewCompletedEvent extends ReviewCompletedEventInput {
  type: "review.completed";
  sequence: number;
  createdAt: string;
  done: boolean;
  doneReason: ReviewDoneReason | null;
}

export interface WaitForReviewEventsOptions {
  documentPath?: string;
  afterSequence?: number;
  timeoutMs?: number;
  batchWindowMs?: number;
}

export interface WaitForReviewEventsResult {
  events: ReviewCompletedEvent[];
  timedOut: boolean;
  nextSequence: number;
}

interface Waiter {
  options: NormalizedWaitOptions;
  resolve: (result: WaitForReviewEventsResult) => void;
  timeout: NodeJS.Timeout | null;
  batchTimeout: NodeJS.Timeout | null;
}

const DEFAULT_BATCH_WINDOW_MS = 250;
const MAX_RETAINED_EVENTS = 100;

type NormalizedWaitOptions = Required<
  Omit<WaitForReviewEventsOptions, "documentPath" | "timeoutMs">
> & {
  documentPath?: string;
  timeoutMs?: number;
};

export class ReviewEventQueue {
  private events: ReviewCompletedEvent[] = [];
  private waiters = new Set<Waiter>();
  private nextSequence = 1;

  emit(input: ReviewCompletedEventInput): {
    delivered: boolean;
    event: ReviewCompletedEvent;
  } {
    const doneReason = detectDoneSignal(input);
    const event: ReviewCompletedEvent = {
      ...input,
      type: "review.completed",
      sequence: this.nextSequence,
      createdAt: new Date().toISOString(),
      done: doneReason !== null,
      doneReason,
    };
    this.nextSequence += 1;
    this.events.push(event);
    this.events = this.events.slice(-MAX_RETAINED_EVENTS);

    appendSlog("review-events.emit", {
      documentPath: event.documentPath,
      sequence: event.sequence,
      waiters: this.waiters.size,
      hasOverallComment: typeof event.overallComment === "string",
      overallCommentLength: event.overallComment?.length ?? 0,
      doneReason: event.doneReason,
    });

    let delivered = false;
    for (const waiter of [...this.waiters]) {
      if (matchesWaiter(event, waiter.options)) {
        delivered = true;
        this.scheduleResolve(waiter);
      }
    }

    return { delivered, event };
  }

  wait(
    options: WaitForReviewEventsOptions = {},
  ): Promise<WaitForReviewEventsResult> {
    const normalized = normalizeWaitOptions(options);
    const existing = this.matchingEvents(normalized);

    if (existing.length > 0) {
      return Promise.resolve(
        resultForEvents(existing, false, this.nextSequence),
      );
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        options: normalized,
        resolve,
        batchTimeout: null,
        timeout:
          normalized.timeoutMs !== undefined
            ? setTimeout(() => {
                this.resolveWaiter(waiter, true);
              }, normalized.timeoutMs)
            : null,
      };

      this.waiters.add(waiter);
      appendSlog("review-events.wait", {
        documentPath: normalized.documentPath ?? null,
        afterSequence: normalized.afterSequence,
        timeoutMs: normalized.timeoutMs,
      });
    });
  }

  waiterCount(): number {
    return this.waiters.size;
  }

  latestSequence(): number {
    return this.nextSequence - 1;
  }

  waiterCountForDocument(documentPath: string): number {
    const normalizedPath = normalizeDocumentPath(documentPath);
    return [...this.waiters].filter(
      (waiter) => waiter.options.documentPath === normalizedPath,
    ).length;
  }

  private matchingEvents(
    options: NormalizedWaitOptions,
  ): ReviewCompletedEvent[] {
    return this.events.filter((event) => matchesWaiter(event, options));
  }

  private scheduleResolve(waiter: Waiter): void {
    if (waiter.batchTimeout) return;

    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
      waiter.timeout = null;
    }

    waiter.batchTimeout = setTimeout(() => {
      this.resolveWaiter(waiter, false);
    }, waiter.options.batchWindowMs);
  }

  private resolveWaiter(waiter: Waiter, timedOut: boolean): void {
    if (!this.waiters.has(waiter)) return;

    this.waiters.delete(waiter);
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
    }
    if (waiter.batchTimeout) {
      clearTimeout(waiter.batchTimeout);
    }

    const events = timedOut ? [] : this.matchingEvents(waiter.options);
    waiter.resolve(resultForEvents(events, timedOut, this.nextSequence));
  }
}

// The review loop ends only when the reviewer signals it: an overall comment
// that says the review is done, or a submission with every thread cleared.
// The overall comment is checked first because it is persisted into the
// document before the summary is computed, so it always counts as one
// unresolved item of its own.
function detectDoneSignal(
  input: ReviewCompletedEventInput,
): ReviewDoneReason | null {
  if (input.overallComment !== undefined) {
    return isDoneSignalComment(input.overallComment) ? "overall-comment" : null;
  }
  return input.summary.unresolved === 0 ? "threads-cleared" : null;
}

const DONE_SIGNAL_PHRASES = new Set([
  "done",
  "all done",
  "im done",
  "were done",
  "done reviewing",
  "review done",
  "review complete",
  "review completed",
  "review is done",
  "review is complete",
  "finished",
  "finished reviewing",
  "lgtm",
  "looks good",
  "looks good to me",
  "no further comments",
  "no more comments",
  "nothing further",
  // Spanish: the review pages and most of this fork's documents answer with
  // «Listo».
  "listo",
  "todo listo",
  "termine",
  "terminado",
  "ya esta",
  "sin mas comentarios",
  "nada mas",
]);

const DONE_SIGNAL_LEADING_WORDS = /^(?:ok|okay|yes|the|si|bueno)\s+/;
const DONE_SIGNAL_TRAILING_WORDS = /\s+(?:thanks|thank you|ty|gracias)$/;

// A done-signal is the whole overall comment, not a phrase inside it: a false
// positive ends the loop and strands the reviewer's request, while a false
// negative costs one extra round that the threads-cleared rule then ends.
// Approval wording ("approved", "ship it") is deliberately absent: an approval
// resolves the one comment it answers, so it cannot also end the review.
// A question ("Done?") is asking, not signaling, so it is checked before the
// punctuation is stripped.
export function isDoneSignalComment(text: string): boolean {
  if (/[?\uff1f]\s*$/.test(text.trim())) return false;
  let normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  normalized = normalized.replace(DONE_SIGNAL_TRAILING_WORDS, "");
  normalized = normalized.replace(DONE_SIGNAL_LEADING_WORDS, "");
  return DONE_SIGNAL_PHRASES.has(normalized);
}

function normalizeWaitOptions(
  options: WaitForReviewEventsOptions,
): NormalizedWaitOptions {
  return {
    documentPath: options.documentPath
      ? normalizeDocumentPath(options.documentPath)
      : undefined,
    afterSequence: Math.max(0, options.afterSequence ?? 0),
    timeoutMs:
      options.timeoutMs !== undefined
        ? clamp(options.timeoutMs, 0, 300_000)
        : undefined,
    batchWindowMs: clamp(
      options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
      0,
      10_000,
    ),
  };
}

function matchesWaiter(
  event: ReviewCompletedEvent,
  options: NormalizedWaitOptions,
): boolean {
  if (event.sequence <= options.afterSequence) return false;
  if (!options.documentPath) return true;
  return normalizeDocumentPath(event.documentPath) === options.documentPath;
}

// Why: macOS can store a folder like "Áreas" decomposed (NFD) while a typed or
// copied path is composed (NFC). Both name the same file, so a watcher started
// with one spelling must match a page or event that uses the other.
function normalizeDocumentPath(documentPath: string): string {
  return path.resolve(documentPath).normalize("NFC");
}

function resultForEvents(
  events: ReviewCompletedEvent[],
  timedOut: boolean,
  nextSequence: number,
): WaitForReviewEventsResult {
  return {
    events,
    timedOut,
    nextSequence,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function appendSlog(event: string, data: Record<string, unknown>): void {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/server/src/review-events.ts",
      event,
      data,
    })}\n`,
  );
}
