import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isDoneSignalComment, ReviewEventQueue } from "./review-events";

function eventInput(documentPath = "/tmp/project/draft.md") {
  return {
    documentPath,
    projectPath: path.dirname(documentPath),
    relativePath: path.basename(documentPath),
    version: "v1",
    summary: {
      comments: 1,
      replies: 0,
      suggestions: 1,
      unresolved: 2,
    },
  };
}

describe("ReviewEventQueue", () => {
  // macOS can store "Áreas" decomposed (NFD) while a typed path is composed
  // (NFC); both spellings name the same file.
  it("treats NFC and NFD spellings of a path as the same document", async () => {
    vi.useFakeTimers();
    const nfc = "/tmp/\u00c1reas/draft.md";
    const nfd = "/tmp/A\u0301reas/draft.md";
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: nfc,
      timeoutMs: 1_000,
      batchWindowMs: 10,
    });

    expect(queue.waiterCountForDocument(nfd)).toBe(1);

    queue.emit(eventInput(nfd));
    await vi.advanceTimersByTimeAsync(10);

    await expect(waiting).resolves.toMatchObject({ timedOut: false });
    vi.useRealTimers();
  });

  it("queues events in creation order", async () => {
    const queue = new ReviewEventQueue();

    queue.emit(eventInput("/tmp/project/a.md"));
    queue.emit(eventInput("/tmp/project/b.md"));

    const result = await queue.wait({ timeoutMs: 0 });

    expect(result.timedOut).toBe(false);
    expect(result.events.map((event) => event.documentPath)).toEqual([
      "/tmp/project/a.md",
      "/tmp/project/b.md",
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("resolves a waiting watcher when a matching event arrives", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 1_000,
      batchWindowMs: 10,
    });

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(10);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    expect(emitted.delivered).toBe(true);
    vi.useRealTimers();
  });

  it("returns overall comments with delivered events", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 1_000,
      batchWindowMs: 0,
    });

    queue.emit({
      ...eventInput("/tmp/project/draft.md"),
      overallComment: "Please prioritize the CLI contract.",
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
    vi.useRealTimers();
  });

  it("keeps events without overall comments unchanged", async () => {
    const queue = new ReviewEventQueue();

    queue.emit(eventInput("/tmp/project/draft.md"));

    const result = await queue.wait();
    expect(result.events[0]).not.toHaveProperty("overallComment");
  });

  it("keeps a watcher active without a timeout until a matching event arrives", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      batchWindowMs: 0,
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(queue.waiterCount()).toBe(1);

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(0);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    vi.useRealTimers();
  });

  it("ignores unrelated document paths", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 100,
      batchWindowMs: 0,
    });

    const emitted = queue.emit(eventInput("/tmp/project/other.md"));
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toMatchObject({
      timedOut: true,
      events: [],
    });
    expect(emitted.delivered).toBe(false);
    vi.useRealTimers();
  });

  it("batches events during the batch window", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({ timeoutMs: 1_000, batchWindowMs: 50 });

    queue.emit(eventInput("/tmp/project/a.md"));
    await vi.advanceTimersByTimeAsync(25);
    queue.emit(eventInput("/tmp/project/b.md"));
    await vi.advanceTimersByTimeAsync(25);

    const result = await waiting;

    expect(result.events.map((event) => event.documentPath)).toEqual([
      "/tmp/project/a.md",
      "/tmp/project/b.md",
    ]);
    vi.useRealTimers();
  });

  it("does not time out after a matching event arrives during a longer batch window", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath: "/tmp/project/draft.md",
      timeoutMs: 100,
      batchWindowMs: 200,
    });

    await vi.advanceTimersByTimeAsync(50);
    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));
    await vi.advanceTimersByTimeAsync(200);

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      events: [emitted.event],
    });
    expect(emitted.delivered).toBe(true);
    vi.useRealTimers();
  });

  it("prunes retained events deterministically", async () => {
    const queue = new ReviewEventQueue();

    for (let index = 0; index < 105; index += 1) {
      queue.emit(eventInput(`/tmp/project/${index}.md`));
    }

    const result = await queue.wait();

    expect(result.events).toHaveLength(100);
    expect(result.events[0]?.sequence).toBe(6);
    expect(result.events.at(-1)?.sequence).toBe(105);
  });
});

describe("isDoneSignalComment", () => {
  it.each([
    "done",
    "Done.",
    "DONE!",
    "all done",
    "I'm done",
    "we're done",
    "done reviewing",
    "review done",
    "review complete",
    "the review is done",
    "finished",
    "finished reviewing",
    "lgtm",
    "looks good",
    "Looks good to me",
    "no further comments",
    "no more comments",
    "nothing further",
    "ok, done",
    "okay done",
    "done, thanks!",
    "Done. Thank you",
    "  done  ",
    "Listo",
    "listo, gracias",
    "Terminé",
    "Ya está",
    "Sin más comentarios",
  ])("reads %j as the reviewer signaling done", (text) => {
    expect(isDoneSignalComment(text)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "not done",
    "not done yet",
    "I'm not done",
    "done with section 2, but section 3 needs work",
    "Done. Now please add a section on risks.",
    "Please prioritize the CLI contract.",
    "almost done",
    "is this done?",
    "Done?",
    "done ?",
    "Finished?",
    "lgtm?",
    "looks good but tighten the intro",
    "undone",
    "approved",
    "Approved!",
    "ship it",
    "okay approved",
    "¿Listo?",
    "listo el punto 2, falta el 3",
  ])("reads %j as feedback that continues the loop", (text) => {
    expect(isDoneSignalComment(text)).toBe(false);
  });
});

describe("ReviewEventQueue done-signal", () => {
  it("marks an event done when the overall comment says done, even with open threads", () => {
    const queue = new ReviewEventQueue();

    const emitted = queue.emit({
      ...eventInput("/tmp/project/draft.md"),
      overallComment: "Done, thanks!",
    });

    expect(emitted.event).toMatchObject({
      done: true,
      doneReason: "overall-comment",
    });
  });

  it("marks an event done when every thread is cleared and there is no overall comment", () => {
    const queue = new ReviewEventQueue();

    const emitted = queue.emit({
      ...eventInput("/tmp/project/draft.md"),
      summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 },
    });

    expect(emitted.event).toMatchObject({
      done: true,
      doneReason: "threads-cleared",
    });
  });

  it("keeps the loop going when threads remain open and the overall comment is feedback", () => {
    const queue = new ReviewEventQueue();

    const emitted = queue.emit({
      ...eventInput("/tmp/project/draft.md"),
      overallComment: "Please prioritize the CLI contract.",
    });

    expect(emitted.event).toMatchObject({ done: false, doneReason: null });
  });

  it("keeps the loop going when threads remain open and nothing was said", () => {
    const queue = new ReviewEventQueue();

    const emitted = queue.emit(eventInput("/tmp/project/draft.md"));

    expect(emitted.event).toMatchObject({ done: false, doneReason: null });
  });
});

describe("ReviewEventQueue comment events", () => {
  const documentPath = "/tmp/project/draft.md";

  function commentInput(text = "Why this?") {
    return {
      documentPath,
      projectPath: path.dirname(documentPath),
      relativePath: path.basename(documentPath),
      version: "v2",
      comments: [
        {
          id: "c1",
          kind: "comment" as const,
          parentId: null,
          text,
          anchorText: "the claim",
          author: "user",
        },
      ],
    };
  }

  it("never wakes or feeds a waiter that did not ask for comments", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath,
      timeoutMs: 10_000,
      batchWindowMs: 0,
    });
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    const emitted = queue.emitComments(commentInput());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(emitted.delivered).toBe(false);
    expect(settled).toBe(false);

    queue.emit(eventInput(documentPath));
    await vi.advanceTimersByTimeAsync(0);
    const result = await waiting;

    expect(result.events.map((event) => event.type)).toEqual([
      "review.completed",
    ]);
    vi.useRealTimers();
  });

  it("does not replay retained comment events to a plain waiter", async () => {
    const queue = new ReviewEventQueue();
    queue.emitComments(commentInput());

    const result = await queue.wait({ timeoutMs: 0 });

    expect(result.events).toEqual([]);
  });

  it("wakes a comments waiter after the 3 second batch window with every comment", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath,
      timeoutMs: 60_000,
      includeComments: true,
    });

    queue.emitComments(commentInput("first"));
    await vi.advanceTimersByTimeAsync(2_000);
    queue.emitComments(commentInput("second"));
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await waiting;

    expect(result.timedOut).toBe(false);
    expect(result.events.map((event) => event.type)).toEqual([
      "comment.added",
      "comment.added",
    ]);
    expect(
      result.events.map((event) =>
        event.type === "comment.added" ? event.comments[0]?.text : null,
      ),
    ).toEqual(["first", "second"]);
    vi.useRealTimers();
  });

  it("lets Done Reviewing cut a comment batch short", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath,
      timeoutMs: 60_000,
      includeComments: true,
    });

    queue.emitComments(commentInput());
    await vi.advanceTimersByTimeAsync(100);
    queue.emit(eventInput(documentPath));
    await vi.advanceTimersByTimeAsync(250);
    const result = await waiting;

    expect(result.events.map((event) => event.type)).toEqual([
      "comment.added",
      "review.completed",
    ]);
    vi.useRealTimers();
  });

  it("honors an explicit batch window for comments", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath,
      timeoutMs: 60_000,
      includeComments: true,
      batchWindowMs: 100,
    });

    queue.emitComments(commentInput());
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toMatchObject({ timedOut: false });
    vi.useRealTimers();
  });

  it("keeps the document watched for 30 seconds after a comments waiter returns", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();
    const waiting = queue.wait({
      documentPath,
      timeoutMs: 60_000,
      includeComments: true,
      batchWindowMs: 0,
    });
    expect(queue.isDocumentWatched(documentPath)).toBe(true);

    queue.emitComments(commentInput());
    await vi.advanceTimersByTimeAsync(0);
    await waiting;

    expect(queue.waiterCountForDocument(documentPath)).toBe(0);
    expect(queue.isDocumentWatched(documentPath)).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(queue.isDocumentWatched(documentPath)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(queue.isDocumentWatched(documentPath)).toBe(false);
    vi.useRealTimers();
  });

  it("gives no grace after Done Reviewing or a timeout", async () => {
    vi.useFakeTimers();
    const queue = new ReviewEventQueue();

    const timedOut = queue.wait({
      documentPath,
      timeoutMs: 1_000,
      includeComments: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;
    expect(queue.isDocumentWatched(documentPath)).toBe(false);

    const waiting = queue.wait({
      documentPath,
      timeoutMs: 60_000,
      includeComments: true,
      batchWindowMs: 0,
    });
    queue.emitComments(commentInput());
    queue.emit(eventInput(documentPath));
    await vi.advanceTimersByTimeAsync(250);
    await waiting;
    expect(queue.isDocumentWatched(documentPath)).toBe(false);
    vi.useRealTimers();
  });
});

describe("ReviewEventQueue comment catch-up", () => {
  const documentPath = "/tmp/project/draft.md";
  const comment = (text: string) => ({
    documentPath,
    projectPath: path.dirname(documentPath),
    relativePath: path.basename(documentPath),
    version: "v2",
    comments: [
      {
        id: text,
        kind: "comment" as const,
        parentId: null,
        text,
        anchorText: null,
        author: "user",
      },
    ],
  });
  const fromNow = (queue: ReviewEventQueue, extra = {}) =>
    queue.wait({
      documentPath,
      afterSequence: queue.latestSequence(),
      timeoutMs: 0,
      batchWindowMs: 0,
      includeComments: true,
      catchUpComments: true,
      ...extra,
    });

  it("delivers a comment saved between two waits to the second, once", async () => {
    const queue = new ReviewEventQueue();
    await fromNow(queue); // first watch: starts from now, sets the mark
    queue.emitComments(comment("while-replying"));

    const second = await fromNow(queue);
    const third = await fromNow(queue);

    expect(second.events).toMatchObject([
      { type: "comment.added", comments: [{ id: "while-replying" }] },
    ]);
    expect(third.events).toEqual([]);
  });

  it("does not hand a comment again after a parked waiter received it", async () => {
    const queue = new ReviewEventQueue();
    await fromNow(queue);
    const parked = queue.wait({
      documentPath,
      afterSequence: queue.latestSequence(),
      timeoutMs: 5_000,
      batchWindowMs: 0,
      includeComments: true,
      catchUpComments: true,
    });
    queue.emitComments(comment("live"));
    expect((await parked).events).toHaveLength(1);

    expect((await fromNow(queue)).events).toEqual([]);
  });

  it("does not replay comments written before the first comments waiter", async () => {
    const queue = new ReviewEventQueue();
    queue.emitComments(comment("before-anyone-watched"));

    expect((await fromNow(queue)).events).toEqual([]);
  });

  it("leaves plain waiters and explicit afterSequence alone", async () => {
    const queue = new ReviewEventQueue();
    await fromNow(queue);
    queue.emitComments(comment("c-a"));
    queue.emitComments(comment("c-b"));

    const plain = await queue.wait({
      documentPath,
      afterSequence: queue.latestSequence(),
      timeoutMs: 0,
    });
    const explicit = await fromNow(queue, {
      afterSequence: 0,
      catchUpComments: false,
    });

    expect(plain.events).toEqual([]);
    expect(explicit.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("keeps marks per document", async () => {
    const queue = new ReviewEventQueue();
    await fromNow(queue);
    queue.emitComments({
      ...comment("elsewhere"),
      documentPath: "/tmp/project/other.md",
      relativePath: "other.md",
    });

    expect((await fromNow(queue)).events).toEqual([]);
  });
});
