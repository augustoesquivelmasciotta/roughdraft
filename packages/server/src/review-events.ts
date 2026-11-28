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

export interface ReviewCommentAddedItem {
  id: string;
  kind: "comment" | "reply";
  parentId: string | null;
  text: string;
  anchorText: string | null;
  author: string | null;
}

export interface ReviewCommentAddedEventInput {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  version: string;
  comments: ReviewCommentAddedItem[];
}

// Emitted while the reviewer is still reading: one event per save that adds
// comments or replies. Only waiters that ask for it (includeComments) see it.
export interface ReviewCommentAddedEvent extends ReviewCommentAddedEventInput {
  type: "comment.added";
  sequence: number;
  createdAt: string;
}

export type ReviewEvent = ReviewCompletedEvent | ReviewCommentAddedEvent;

export interface WaitForReviewEventsOptions {
  documentPath?: string;
  afterSequence?: number;
  timeoutMs?: number;
  batchWindowMs?: number;
  /** Also wake on, and receive, `comment.added` events. Default false. */
  includeComments?: boolean;
  /**
   * With includeComments: before waiting, also take the retained comment.added
   * events for the document that no comments waiter has been handed yet (the
   * server's per-document mark). Lets a waiter that starts "from now" still
   * receive a comment written while the agent was answering the last one.
   */
  catchUpComments?: boolean;
}

export interface WaitForReviewEventsResult<
  E extends ReviewEvent = ReviewCompletedEvent,
> {
  events: E[];
  timedOut: boolean;
  nextSequence: number;
}

interface Waiter {
  options: NormalizedWaitOptions;
  resolve: (result: WaitForReviewEventsResult<ReviewEvent>) => void;
  timeout: NodeJS.Timeout | null;
  batchTimeout: NodeJS.Timeout | null;
  batchDueAt: number | null;
}

const DEFAULT_BATCH_WINDOW_MS = 250;
// Comments are written in bursts (a comment, then its follow-up), so a waiter
// that asks for them gathers a few seconds of them into one wake-up.
export const DEFAULT_COMMENT_BATCH_WINDOW_MS = 3_000;
// After a comments-waiter returns, the agent needs a moment to answer and wait
// again. The document keeps counting as watched for this long, so the «I'm
// done» button does not vanish between rounds.
export const WATCHED_GRACE_MS = 30_000;
const MAX_RETAINED_EVENTS = 100;

type NormalizedWaitOptions = Required<
  Omit<WaitForReviewEventsOptions, "documentPath" | "timeoutMs">
> & {
  documentPath?: string;
  timeoutMs?: number;
};

export class ReviewEventQueue {
  private events: ReviewEvent[] = [];
  private waiters = new Set<Waiter>();
  private nextSequence = 1;
  private graceUntil = new Map<string, number>();
  // Highest comment.added sequence handed to a comments waiter, per document.
  private commentMarks = new Map<string, number>();

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
    // The round is over: nobody is expected to wait again for this document.
    this.graceUntil.delete(normalizeDocumentPath(event.documentPath));

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
        // Done Reviewing must not sit behind a comment batch window.
        this.scheduleResolve(
          waiter,
          waiter.options.includeComments
            ? Math.min(waiter.options.batchWindowMs, DEFAULT_BATCH_WINDOW_MS)
            : waiter.options.batchWindowMs,
        );
      }
    }

    return { delivered, event };
  }

  emitComments(input: ReviewCommentAddedEventInput): {
    delivered: boolean;
    event: ReviewCommentAddedEvent;
  } {
    const event: ReviewCommentAddedEvent = {
      ...input,
      type: "comment.added",
      sequence: this.nextSequence,
      createdAt: new Date().toISOString(),
    };
    this.nextSequence += 1;
    this.events.push(event);
    this.events = this.events.slice(-MAX_RETAINED_EVENTS);

    appendSlog("review-events.emit-comments", {
      documentPath: event.documentPath,
      sequence: event.sequence,
      waiters: this.waiters.size,
      comments: event.comments.length,
    });

    let delivered = false;
    for (const waiter of [...this.waiters]) {
      if (matchesWaiter(event, waiter.options)) {
        delivered = true;
        this.scheduleResolve(waiter, waiter.options.batchWindowMs);
      }
    }

    return { delivered, event };
  }

  wait(
    options: WaitForReviewEventsOptions & { includeComments: true },
  ): Promise<WaitForReviewEventsResult<ReviewEvent>>;
  wait(
    options?: WaitForReviewEventsOptions & { includeComments?: false },
  ): Promise<WaitForReviewEventsResult>;
  wait(
    options: WaitForReviewEventsOptions,
  ): Promise<WaitForReviewEventsResult<ReviewEvent>>;
  wait(
    options: WaitForReviewEventsOptions = {},
  ): Promise<WaitForReviewEventsResult<ReviewEvent>> {
    const normalized = normalizeWaitOptions(options);
    let existing = this.matchingEvents(normalized);

    if (normalized.includeComments && normalized.documentPath) {
      // The first comments waiter for a document starts from now: comments
      // written before anyone asked for them were not missed by a loop.
      if (!this.commentMarks.has(normalized.documentPath)) {
        this.commentMarks.set(normalized.documentPath, this.latestSequence());
      }
      if (normalized.catchUpComments) {
        const mark = this.commentMarks.get(normalized.documentPath) ?? 0;
        const pending = this.events.filter(
          (event) =>
            event.type === "comment.added" &&
            event.sequence > mark &&
            normalizeDocumentPath(event.documentPath) ===
              normalized.documentPath &&
            !existing.includes(event),
        );
        existing = [...existing, ...pending].sort(
          (a, b) => a.sequence - b.sequence,
        );
      }
    }

    if (existing.length > 0) {
      this.markCommentsDelivered(normalized, existing);
      return Promise.resolve(
        resultForEvents(existing, false, this.nextSequence),
      );
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        options: normalized,
        resolve,
        batchTimeout: null,
        batchDueAt: null,
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

  // A document counts as watched while a waiter is on it, and for a grace
  // period after a comments-waiter returned with comments (see
  // WATCHED_GRACE_MS).
  isDocumentWatched(documentPath: string): boolean {
    if (this.waiterCountForDocument(documentPath) > 0) return true;
    const until = this.graceUntil.get(normalizeDocumentPath(documentPath));
    return until !== undefined && until > Date.now();
  }

  private markCommentsDelivered(
    options: NormalizedWaitOptions,
    events: ReviewEvent[],
  ): void {
    if (!options.includeComments || !options.documentPath) return;
    let mark = this.commentMarks.get(options.documentPath) ?? 0;
    for (const event of events) {
      if (event.type === "comment.added") mark = Math.max(mark, event.sequence);
    }
    this.commentMarks.set(options.documentPath, mark);
  }

  private matchingEvents(options: NormalizedWaitOptions): ReviewEvent[] {
    return this.events.filter((event) => matchesWaiter(event, options));
  }

  private scheduleResolve(waiter: Waiter, delayMs: number): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
      waiter.timeout = null;
    }

    const dueAt = Date.now() + delayMs;
    if (waiter.batchTimeout) {
      // Already batching: only ever shorten the wait, never extend it.
      if (waiter.batchDueAt !== null && waiter.batchDueAt <= dueAt) return;
      clearTimeout(waiter.batchTimeout);
    }

    waiter.batchDueAt = dueAt;
    waiter.batchTimeout = setTimeout(() => {
      this.resolveWaiter(waiter, false);
    }, delayMs);
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
    this.markCommentsDelivered(waiter.options, events);
    if (
      !timedOut &&
      waiter.options.includeComments &&
      waiter.options.documentPath &&
      events.some((event) => event.type === "comment.added") &&
      !events.some((event) => event.type === "review.completed")
    ) {
      this.graceUntil.set(
        waiter.options.documentPath,
        Date.now() + WATCHED_GRACE_MS,
      );
    }
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
  const includeComments = options.includeComments === true;
  return {
    includeComments,
    catchUpComments: includeComments && options.catchUpComments === true,
    documentPath: options.documentPath
      ? normalizeDocumentPath(options.documentPath)
      : undefined,
    afterSequence: Math.max(0, options.afterSequence ?? 0),
    timeoutMs:
      options.timeoutMs !== undefined
        ? clamp(options.timeoutMs, 0, 300_000)
        : undefined,
    batchWindowMs: clamp(
      options.batchWindowMs ??
        (includeComments
          ? DEFAULT_COMMENT_BATCH_WINDOW_MS
          : DEFAULT_BATCH_WINDOW_MS),
      0,
      10_000,
    ),
  };
}

function matchesWaiter(
  event: ReviewEvent,
  options: NormalizedWaitOptions,
): boolean {
  if (event.sequence <= options.afterSequence) return false;
  if (event.type === "comment.added" && !options.includeComments) return false;
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
  events: ReviewEvent[],
  timedOut: boolean,
  nextSequence: number,
): WaitForReviewEventsResult<ReviewEvent> {
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
