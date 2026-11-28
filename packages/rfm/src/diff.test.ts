import { describe, expect, it } from "vitest";
import {
  diffRoughdraftDocuments,
  diffTextBlocks,
  diffWordRanges,
  extractDiffBlocks,
  stripRoughdraftReviewMarks,
} from "./index.js";

const baseline = [
  "# Plan",
  "",
  "The first paragraph stays exactly the same.",
  "",
  "We will ship the report on Friday afternoon.",
  "",
  "- item one",
  "- item two",
  "",
  "A paragraph that will be removed entirely.",
  "",
  "Closing words.",
  "",
].join("\n");

describe("diffRoughdraftDocuments", () => {
  it("reports nothing for identical documents", () => {
    const diff = diffRoughdraftDocuments(baseline, baseline);
    expect(diff.changes).toEqual([]);
    expect(diff.summary).toMatchObject({ total: 0, unchanged: 7 });
  });

  it("reports an added block", () => {
    const current = baseline.replace(
      "Closing words.",
      "A brand new paragraph.\n\nClosing words.",
    );
    const diff = diffRoughdraftDocuments(baseline, current);
    expect(diff.summary).toMatchObject({ added: 1, changed: 0, removed: 0 });
    expect(diff.changes[0]).toMatchObject({
      kind: "added",
      newText: "A brand new paragraph.",
      oldText: "",
      oldLine: null,
    });
  });

  it("reports a changed block with the word ranges that differ", () => {
    const current = baseline.replace(
      "on Friday afternoon",
      "on Monday morning",
    );
    const diff = diffRoughdraftDocuments(baseline, current);
    expect(diff.summary).toMatchObject({ added: 0, changed: 1, removed: 0 });
    const change = diff.changes[0];
    expect(change?.kind).toBe("changed");
    expect(change?.oldText).toBe(
      "We will ship the report on Friday afternoon.",
    );
    const text = change?.newText ?? "";
    const words = change?.ranges.map((range) =>
      text.slice(range.start, range.end),
    );
    expect(words).toEqual(["Monday morning."]);
  });

  it("reports a removed block where it was", () => {
    const current = baseline.replace(
      "A paragraph that will be removed entirely.\n\n",
      "",
    );
    const diff = diffRoughdraftDocuments(baseline, current);
    expect(diff.summary).toMatchObject({ added: 0, changed: 0, removed: 1 });
    expect(diff.changes[0]).toMatchObject({
      kind: "removed",
      oldText: "A paragraph that will be removed entirely.",
      newText: "",
    });
  });

  it("does not count a block that only moved", () => {
    const current = [
      "# Plan",
      "",
      "Closing words.",
      "",
      "The first paragraph stays exactly the same.",
      "",
      "We will ship the report on Friday afternoon.",
      "",
      "- item one",
      "- item two",
      "",
      "A paragraph that will be removed entirely.",
      "",
    ].join("\n");
    expect(diffRoughdraftDocuments(baseline, current).summary.total).toBe(0);
  });

  it("treats an edited and moved paragraph as changed, not removed plus added", () => {
    const current = baseline
      .replace("We will ship the report on Friday afternoon.\n\n", "")
      .replace(
        "Closing words.",
        "We will ship the report on Friday evening.\n\nClosing words.",
      );
    const diff = diffRoughdraftDocuments(baseline, current);
    expect(diff.summary.removed + diff.summary.added).toBeLessThanOrEqual(2);
    expect(
      diff.changes.some((change) => change.newText.includes("evening")),
    ).toBe(true);
  });

  it("compares list items, table cells and code blocks", () => {
    const before = [
      "- alpha",
      "- beta",
      "",
      "| a | b |",
      "| - | - |",
      "| one | two |",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
    ].join("\n");
    const after = before
      .replace("- beta", "- beta\n- gamma")
      .replace("| one | two |", "| one | three |")
      .replace("const x = 1;", "const x = 2;");
    const diff = diffRoughdraftDocuments(before, after);
    const byKind = Object.fromEntries(
      diff.changes.map((change) => [change.newText, change.blockKind]),
    );
    expect(byKind.gamma).toBe("list-item");
    expect(byKind.three).toBe("table-cell");
    expect(byKind["const x = 2;"]).toBe("code");
    expect(diff.summary.total).toBe(3);
  });

  it("ignores formatting syntax", () => {
    const before = "Some **bold** text with a [link](https://example.com).\n";
    const after = "Some bold text with a link.\n";
    expect(diffRoughdraftDocuments(before, after).summary.total).toBe(0);
  });

  it("does not treat a new comment, a reply or endmatter as a change", () => {
    const current = [
      baseline.replace(
        "Friday afternoon.",
        "{==Friday afternoon.==}{>>Is this still right?<<}{#c1}",
      ),
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: AI",
      "    at: 2026-11-28T12:00:00.000Z",
      "  c2:",
      "    body: Yes.",
      "    by: AI",
      "    re: c1",
      "",
    ].join("\n");
    const diff = diffRoughdraftDocuments(baseline, current);
    expect(diff.changes).toEqual([]);
  });

  it("treats a legacy inline comment and a suggestion as non-content", () => {
    const current = baseline
      .replace("item one", 'item one{>>why?<<}{id="c9" by="AI"}')
      .replace("Closing words.", "Closing{++ extra++} words.");
    expect(diffRoughdraftDocuments(baseline, current).changes).toEqual([]);
  });

  it("still sees real edits next to review marks", () => {
    const current = baseline.replace(
      "Closing words.",
      "Closing words, now longer. {>>nice<<}{#c3}",
    );
    const diff = diffRoughdraftDocuments(baseline, current);
    expect(diff.summary.changed).toBe(1);
  });
});

describe("helpers", () => {
  it("strips marks but leaves fenced code alone", () => {
    const md = ["```", "{>>keep me<<}", "```", "", "text {>>gone<<}{#c1}"].join(
      "\n",
    );
    expect(stripRoughdraftReviewMarks(md)).toContain("{>>keep me<<}");
    expect(stripRoughdraftReviewMarks(md)).not.toContain("gone");
  });

  it("splits markdown into plain blocks with their lines", () => {
    const blocks = extractDiffBlocks("# Title\n\nfirst\nsecond\n\n1. one\n");
    expect(blocks).toEqual([
      { kind: "heading", line: 1, text: "Title" },
      { kind: "paragraph", line: 3, text: "first second" },
      { kind: "list-item", line: 6, text: "one" },
    ]);
  });

  it("diffTextBlocks places a removal in front of the next block", () => {
    const diff = diffTextBlocks(["a", "b", "c"], ["a", "c"]);
    expect(diff.removed).toEqual([{ oldIndex: 1, beforeNewIndex: 1 }]);
    expect(diff.blocks.map((block) => block.status)).toEqual(["same", "same"]);
  });

  it("diffWordRanges merges adjacent new words", () => {
    expect(diffWordRanges("a b c", "a x y c")).toEqual([{ start: 2, end: 5 }]);
  });
});
