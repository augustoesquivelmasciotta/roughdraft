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
