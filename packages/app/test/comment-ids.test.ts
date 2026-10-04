import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  type CriticComment,
  createCriticComment,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";

// Reproduces a bug seen in real files: Roughdraft wrote comment ids that were
// already in use (two `c1`, two `c2`, two `c5` in one document), and a comment
// anchored to two highlights got its id written twice. Review ids are
// document-local and must be unique across inline metadata and YAML endmatter.

/**
 * Ids claimed by inline review metadata, in document order: attribute blocks
 * such as `{id="c1" by="user" at="..."}` and compact references such as `{#c1}`.
 */
function inlineMetadataIds(markdown: string): string[] {
  return [
    ...markdown.matchAll(
      /\{#([A-Za-z][A-Za-z0-9_-]*)\}|\{[^{}]*?\bid="([^"]+)"[^{}]*\}/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? "");
}

function repeatedValues(values: string[]): string[] {
  return [
    ...new Set(
      values.filter((value, index) => values.indexOf(value) !== index),
    ),
  ];
}

function countOccurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

function commentBodies(comments: Map<string, CriticComment>): string[] {
  return [...comments.values()].map((comment) => comment.content).sort();
}

function commentIds(comments: Map<string, CriticComment>): string[] {
  return [...comments.values()].map((comment) => comment.id);
}

/** Opens a file in the rich-text model and saves it back, as the app does. */
function openAndSave(markdown: string): string {
  const { doc, comments, frontmatter, endmatter } =
    criticMarkdownToEditorState(markdown);

  return editorStateToCriticMarkdown(doc, comments, { frontmatter, endmatter });
}

function positionOfText(editor: Editor, text: string): number {
  let position: number | null = null;

  editor.state.doc.descendants((node, pos) => {
    if (position !== null) return false;
    if (!node.isText || !node.text) return;

    const offset = node.text.indexOf(text);
    if (offset >= 0) position = pos + offset;
  });

  if (position === null) {
    throw new Error(`Text not found in editor: ${text}`);
  }

  return position;
}

const commentWithoutMetadataBeforeExplicitC1 = {
  "inline attribute metadata": [
    "{==first claim==}{>>Note written without metadata<<}",
    "",
    '{==second claim==}{>>Comment that owns c1<<}{id="c1" by="user" at="2026-10-01T10:00:00.000Z"}',
    "",
  ].join("\n"),
  "YAML endmatter references": [
    "{==first claim==}{>>Note written without metadata<<}",
    "",
    "{==second claim==}{>>Comment that owns c1<<}{#c1}",
    "",
    "---",
    "comments:",
    "  c1:",
    "    by: user",
    '    at: "2026-10-01T10:00:00.000Z"',
    "",
  ].join("\n"),
};

describe.each(
  Object.entries(commentWithoutMetadataBeforeExplicitC1),
)("a comment without metadata that appears before an explicit c1 (%s)", (_metadataStyle, markdown) => {
  it("loads both comments under different ids", () => {
    const { comments } = criticMarkdownToEditorState(markdown);

    expect(commentBodies(comments)).toEqual([
      "Comment that owns c1",
      "Note written without metadata",
    ]);
    expect(repeatedValues(commentIds(comments))).toEqual([]);
    expect(comments.get("c1")?.content).toBe("Comment that owns c1");
  });

  it("saves without writing any id twice and keeps each comment on its own highlight", () => {
    const saved = openAndSave(markdown);

    expect(
      repeatedValues(inlineMetadataIds(saved)),
      "ids written more than once",
    ).toEqual([]);
    expect(saved).toContain(
      "{==first claim==}{>>Note written without metadata<<}",
    );
    expect(saved).toContain("{==second claim==}{>>Comment that owns c1<<}");
  });
});

describe("a comment whose highlight spans two paragraphs", () => {
  const body = "Tighten both sentences.";

  function newComment(id: string): CriticComment {
    return {
      id,
      content: body,
      createdAt: "2026-10-01T10:00:00.000Z",
      authorType: "user",
      authorId: "user",
    };
  }

  /** Highlights "needs work." through "Closing sentence", adds the comment, and saves. */
  function commentAcrossParagraphsAndSave(
    markdown: string,
    comment: CriticComment,
  ): string {
    const parsed = criticMarkdownToEditorState(markdown);
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: parsed.doc,
    });

    try {
      const from = positionOfText(editor, "needs work");
      const to =
        positionOfText(editor, "Closing sentence") + "Closing sentence".length;

      editor.commands.setTextSelection({ from, to });
      expect(editor.state.doc.textBetween(from, to, "\n")).toBe(
        "needs work.\nClosing sentence",
      );
      editor.commands.setCommentRef({ commentIds: [comment.id] });

      return editorStateToCriticMarkdown(
        editor.getJSON(),
        new Map(parsed.comments).set(comment.id, comment),
        { frontmatter: parsed.frontmatter, endmatter: parsed.endmatter },
      );
    } finally {
      editor.destroy();
    }
  }

  it("writes its comment block and id once with inline attribute metadata", () => {
    const saved = commentAcrossParagraphsAndSave(
      "Opening sentence needs work.\n\nClosing sentence does too.\n",
      newComment("c1"),
    );

    expect(countOccurrences(saved, `{>>${body}<<}`)).toBe(1);
    expect(inlineMetadataIds(saved)).toEqual(["c1"]);

    const reopened = criticMarkdownToEditorState(saved);
    expect(commentBodies(reopened.comments)).toEqual([body]);
    expect(JSON.stringify(reopened.doc.content)).not.toContain("{==");
  });

  it("writes its comment block and id once with YAML endmatter references", () => {
    const saved = commentAcrossParagraphsAndSave(
      [
        "Opening sentence needs work.",
        "",
        "Closing sentence does too.",
        "",
        "---",
        "comments:",
        "  c1:",
        "    body: Overall this reads well.",
        "    by: user",
        '    at: "2026-10-01T09:00:00.000Z"',
        "",
      ].join("\n"),
      newComment("c2"),
    );

    expect(countOccurrences(saved, `{>>${body}<<}`)).toBe(1);
    expect(inlineMetadataIds(saved)).toEqual(["c2"]);

    const reopened = criticMarkdownToEditorState(saved);
    expect(commentBodies(reopened.comments)).toEqual([
      "Overall this reads well.",
      body,
    ]);
    expect(JSON.stringify(reopened.doc.content)).not.toContain("{==");
  });
});

const twoDifferentCommentsSharingC2 = {
  "inline attribute metadata": [
    '{==alpha==}{>>First comment<<}{id="c2" by="user" at="2026-10-01T10:00:00.000Z"}',
    "",
    '{==beta==}{>>Second comment<<}{id="c2" by="user" at="2026-10-01T10:01:00.000Z"}',
    "",
  ].join("\n"),
  "YAML endmatter references": [
    "{==alpha==}{>>First comment<<}{#c2}",
    "",
    "{==beta==}{>>Second comment<<}{#c2}",
    "",
    "---",
    "comments:",
    "  c2:",
    "    by: user",
    '    at: "2026-10-01T10:00:00.000Z"',
    "",
  ].join("\n"),
};

describe.each(
  Object.entries(twoDifferentCommentsSharingC2),
)("a file where two different comments already share c2 (%s)", (_metadataStyle, markdown) => {
  it("loads both comments under different ids", () => {
    const { comments } = criticMarkdownToEditorState(markdown);

    expect(commentBodies(comments)).toEqual([
      "First comment",
      "Second comment",
    ]);
    expect(repeatedValues(commentIds(comments))).toEqual([]);
  });

  it("saves both comments under unique ids, each on its own highlight", () => {
    const saved = openAndSave(markdown);

    expect(
      repeatedValues(inlineMetadataIds(saved)),
      "ids written more than once",
    ).toEqual([]);
    expect(saved).toContain("{==alpha==}{>>First comment<<}");
    expect(saved).toContain("{==beta==}{>>Second comment<<}");
  });
});

describe("the id given to a new comment", () => {
  /**
   * Mirrors the app: new ids are allocated from the comments the file loaded
   * plus every id the file already uses anywhere (`reservedIds`).
   */
  function newCommentIdFor(markdown: string): string {
    const { comments, reservedIds } = criticMarkdownToEditorState(markdown);

    return createCriticComment(undefined, {
      existingComments: comments.values(),
      reservedIds,
    }).id;
  }

  it("is not an id held only by YAML endmatter replies", () => {
    const markdown = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-01T10:00:00.000Z"',
      "  c2:",
      "    body: I can soften it instead.",
      "    by: AI",
      '    at: "2026-10-01T10:01:00.000Z"',
      "    re: c1",
      "  c3:",
      "    body: Please do.",
      "    by: user",
      '    at: "2026-10-01T10:02:00.000Z"',
      "    re: c2",
      "",
    ].join("\n");

    expect(["c1", "c2", "c3"]).not.toContain(newCommentIdFor(markdown));
  });

  it("is not an id held by a YAML endmatter entry that no inline marker references", () => {
    const markdown = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-01T10:00:00.000Z"',
      "  c2:",
      "    by: user",
      '    at: "2026-10-01T10:05:00.000Z"',
      "",
    ].join("\n");

    expect(["c1", "c2"]).not.toContain(newCommentIdFor(markdown));
  });

  it("is not an existing suggestion id", () => {
    const markdown = [
      "Add {++one concrete example++}{#s1}.",
      "",
      "---",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-10-01T10:00:00.000Z"',
      "",
    ].join("\n");

    expect(["s1"]).not.toContain(newCommentIdFor(markdown));
  });
});
