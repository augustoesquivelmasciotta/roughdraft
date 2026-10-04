import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
// From packages/app, `@roughdraft/rfm` resolves only to rfm's gitignored dist
// build (CI runs tests before building it), so import the validator source, as
// the server's vitest alias does.
import { validateRoughdraftMarkdown } from "../../rfm/src/index";
import {
  type CriticComment,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";

const documents = [
  {
    metadata: "inline attribute metadata",
    markdown: [
      "# Field notes",
      "Intro paragraph before the review.",
      "",
      'The team agreed on {==the launch checklist==}{>>Short note.<<}{id="c1" by="user" at="2026-10-01T10:00:00.000Z"} last week.',
      "",
      "Closing paragraph after the review.",
      "",
    ].join("\n"),
  },
  {
    metadata: "a compact reference backed by YAML endmatter",
    markdown: [
      "# Field notes",
      "Intro paragraph before the review.",
      "",
      "The team agreed on {==the launch checklist==}{>>Short note.<<}{#c1} last week.",
      "",
      "Closing paragraph after the review.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-01T10:00:00.000Z"',
      "",
    ].join("\n"),
  },
];

const visibleDocumentText = [
  "Field notes",
  "Intro paragraph before the review.",
  "The team agreed on the launch checklist last week.",
  "Closing paragraph after the review.",
].join("\n");

// A pasted article of about 10k characters: paragraphs separated by blank
// lines, lines that start with Markdown block syntax, and literal review
// syntax. Built deterministically so every run sees the same body.
function buildPastedArticle(minimumLength: number): string {
  const blocks: string[] = [];

  for (
    let section = 1;
    blocks.join("\n\n").length < minimumLength;
    section += 1
  ) {
    blocks.push(
      `# Section ${section} of the pasted article`,
      `Paragraph ${section} reads like ordinary prose.\nIt wraps onto a second line inside the same paragraph.`,
      `- First bullet in section ${section}\n- Second bullet in section ${section}`,
      `> A quoted line from section ${section}`,
      `1. First numbered step in section ${section}\n2. Second numbered step in section ${section}`,
      "---",
      ["```", `const section = ${section};`, "```"].join("\n"),
      "The article quotes review syntax literally: {==a highlight==}{>>a comment<<} and stray <<} or ==} delimiters.",
    );
  }

  return blocks.join("\n\n");
}

const pastedArticle = buildPastedArticle(10_000);

type ParsedDocument = ReturnType<typeof criticMarkdownToEditorState>;

// Saves the way PageCard does: editor JSON plus the comments map, with the
// frontmatter and endmatter captured when the file was parsed.
function saveLikeTheApp(
  parsed: ParsedDocument,
  doc: JSONContent = parsed.doc,
  comments: Map<string, CriticComment> = parsed.comments,
): string {
  return editorStateToCriticMarkdown(doc, comments, {
    frontmatter: parsed.frontmatter,
    endmatter: parsed.endmatter,
  });
}

// Mirrors PageCard's updateComment: the edited comment replaces its entry.
function withCommentContent(
  comments: Map<string, CriticComment>,
  commentId: string,
  content: string,
): Map<string, CriticComment> {
  const comment = comments.get(commentId);
  if (!comment) throw new Error(`Fixture has no comment ${commentId}`);

  return new Map(comments).set(commentId, { ...comment, content });
}

function textOf(node: JSONContent): string {
  return node.text ?? (node.content ?? []).map(textOf).join("");
}

function anchoredText(doc: JSONContent, commentId: string): string {
  const parts: string[] = [];
  const visit = (node: JSONContent) => {
    const isAnchored = (node.marks ?? []).some((mark) => {
      const commentIds: unknown = mark.attrs?.commentIds;
      return (
        mark.type === "commentRef" &&
        Array.isArray(commentIds) &&
        commentIds.includes(commentId)
      );
    });
    if (isAnchored && node.text) parts.push(node.text);
    for (const child of node.content ?? []) {
      visit(child);
    }
  };

  visit(doc);
  return parts.join("");
}

// Whole-value diffs of 10k-character strings are unreadable, so failures
// report a window around the first differing offset instead.
function firstDifference(actual: string, expected: string) {
  let offset = 0;
  while (
    offset < actual.length &&
    offset < expected.length &&
    actual[offset] === expected[offset]
  ) {
    offset += 1;
  }
  if (offset === actual.length && offset === expected.length) return null;

  const start = Math.max(0, offset - 60);
  return {
    offset,
    actual: actual.slice(start, offset + 60),
    expected: expected.slice(start, offset + 60),
  };
}

describe.each(documents)("a pasted ~10k-character comment with $metadata", ({
  markdown,
}) => {
  it("comes back unchanged after save and reload, still anchored, without touching the document", () => {
    const parsed = criticMarkdownToEditorState(markdown);
    const saved = saveLikeTheApp(
      parsed,
      parsed.doc,
      withCommentContent(parsed.comments, "c1", pastedArticle),
    );
    const reloaded = criticMarkdownToEditorState(saved);
    const validation = validateRoughdraftMarkdown(saved);

    expect
      .soft(
        firstDifference(
          reloaded.comments.get("c1")?.content ?? "",
          pastedArticle,
        ),
        "reloaded comment body",
      )
      .toBeNull();
    expect
      .soft([...reloaded.comments.keys()], "comment ids after reload")
      .toEqual(["c1"]);
    expect
      .soft(anchoredText(reloaded.doc, "c1"), "text anchored to c1")
      .toBe("the launch checklist");
    expect
      .soft(
        firstDifference(
          (reloaded.doc.content ?? []).map(textOf).join("\n"),
          visibleDocumentText,
        ),
        "document text after reload",
      )
      .toBeNull();
    expect
      .soft(
        validation.errors.map(({ code, line }) => `${code} (line ${line})`),
        "RFM validation errors",
      )
      .toEqual([]);
    expect.soft(validation.ok, "RFM validation ok").toBe(true);
  });

  it("saves byte-identical output when the reloaded document is saved again", () => {
    const parsed = criticMarkdownToEditorState(markdown);
    const firstSave = saveLikeTheApp(
      parsed,
      parsed.doc,
      withCommentContent(parsed.comments, "c1", pastedArticle),
    );
    const secondSave = saveLikeTheApp(criticMarkdownToEditorState(firstSave));

    expect(firstDifference(secondSave, firstSave)).toBeNull();
  });
});
