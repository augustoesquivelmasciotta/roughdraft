import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectNewReviewerComments, replyToComment } from "./review-comments";

const BASE = [
  "# Draft",
  "",
  "Keep {==the claim==}{>>Why this?<<}{#c1} here.",
  "",
  "---",
  "comments:",
  "  c1:",
  "    by: user",
  '    at: "2026-11-28T10:00:00.000Z"',
  "",
].join("\n");

describe("detectNewReviewerComments", () => {
  it("reports a new comment by the user with its anchor", () => {
    const next = BASE.replace(
      "here.",
      "here and {==more text==}{>>Cut this<<}{#c2}.",
    ).replace(
      '    at: "2026-11-28T10:00:00.000Z"\n',
      '    at: "2026-11-28T10:00:00.000Z"\n  c2:\n    by: user\n    at: "2026-11-28T10:05:00.000Z"\n',
    );

    expect(detectNewReviewerComments(BASE, next)).toEqual([
      {
        id: "c2",
        kind: "comment",
        parentId: null,
        text: "Cut this",
        anchorText: "more text",
        author: "user",
      },
    ]);
  });

  it("reports a new reply by the user", () => {
    const next = BASE.replace(
      '    at: "2026-11-28T10:00:00.000Z"\n',
      '    at: "2026-11-28T10:00:00.000Z"\n  c2:\n    body: Actually keep it\n    by: user\n    at: "2026-11-28T10:05:00.000Z"\n    re: c1\n',
    );

    expect(detectNewReviewerComments(BASE, next)).toMatchObject([
      { id: "c2", kind: "reply", parentId: "c1", text: "Actually keep it" },
    ]);
  });

  it("ignores items the agent wrote, in any case", () => {
    const next = BASE.replace(
      '    at: "2026-11-28T10:00:00.000Z"\n',
      '    at: "2026-11-28T10:00:00.000Z"\n  c2:\n    body: Done\n    by: AI\n    at: "2026-11-28T10:05:00.000Z"\n    re: c1\n  c3:\n    body: Also done\n    by: ai\n    at: "2026-11-28T10:06:00.000Z"\n    re: c1\n',
    );

    expect(detectNewReviewerComments(BASE, next)).toEqual([]);
  });

  it("ignores suggestions", () => {
    const next = `${BASE.replace("here.", "here {~~old~>new~~}{#s1}.")}suggestions:\n  s1:\n    by: user\n    at: "2026-11-28T10:05:00.000Z"\n`;

    expect(
      extractRoughdraftReviewIndex(next).items.map((item) => item.kind),
    ).toContain("suggestion");
    expect(detectNewReviewerComments(BASE, next)).toEqual([]);
  });

  it("ignores edits to an existing comment and unrelated prose edits", () => {
    const edited = BASE.replace("Why this?", "Why this, exactly?").replace(
      "# Draft",
      "# Draft title",
    );

    expect(detectNewReviewerComments(BASE, edited)).toEqual([]);
  });

  it("does not report an existing comment again when ids are renumbered", () => {
    const renumbered = BASE.replaceAll("c1", "c7");

    expect(detectNewReviewerComments(BASE, renumbered)).toEqual([]);
  });

  it("reports nothing when the content is unchanged", () => {
    expect(detectNewReviewerComments(BASE, BASE)).toEqual([]);
  });
});

describe("replyToComment", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-reply-"));
    file = path.join(dir, "draft.md");
    fs.writeFileSync(file, BASE);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes an AI reply under the comment and returns its id", () => {
    const result = replyToComment(file, {
      parentId: "c1",
      message: "Changed it.",
    });

    const items = extractRoughdraftReviewIndex(
      fs.readFileSync(file, "utf8"),
    ).items;
    const reply = items.find((item) => item.id === result.id);
    expect(result).toMatchObject({ documentPath: file, parentId: "c1" });
    expect(reply).toMatchObject({
      kind: "reply",
      parentId: "c1",
      text: "Changed it.",
      author: "AI",
    });
  });

  it("uses the given author and rejects an unknown parent without writing", () => {
    const named = replyToComment(file, {
      parentId: "c1",
      message: "Noted.",
      author: "Claude",
    });
    expect(
      extractRoughdraftReviewIndex(fs.readFileSync(file, "utf8")).items.find(
        (item) => item.id === named.id,
      )?.author,
    ).toBe("Claude");

    const before = fs.readFileSync(file, "utf8");
    expect(() =>
      replyToComment(file, { parentId: "nope", message: "x" }),
    ).toThrow(/not found/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
