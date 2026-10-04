import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  type CriticComment,
  createCriticComment,
  criticMarkdownToEditorState,
  criticMarkdownToRenderedHtml,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { buildCommentThreadRailItems } from "../src/document-comments";

// RFM 0.2 lets one file mix metadata formats: these root comments use inline
// attribute blocks, while their replies live only in the final YAML endmatter.
const inlineRootsWithEndmatterReplies = [
  'First paragraph has {==an anchored claim==}{>>Needs a citation.<<}{id="c1" by="user" at="2026-10-01T10:00:00.000Z"}.',
  "",
  'Second paragraph has {==another claim==}{>>Is this still accurate?<<}{id="c2" by="user" at="2026-10-01T10:05:00.000Z"}.',
  "",
  "---",
  "comments:",
  "  c3:",
  "    body: I added a citation from the 2025 report.",
  "    by: AI",
  '    at: "2026-10-01T11:00:00.000Z"',
  "    re: c1",
  "  c4:",
  "    body: Yes, confirmed with the team.",
  "    by: user",
  '    at: "2026-10-01T11:05:00.000Z"',
  "    re: c2",
  "",
].join("\n");

const referenceRootWithEndmatterReply = [
  "Please revisit {==this==}{>>Needs a source.<<}{#c1}.",
  "",
  "---",
  "comments:",
  "  c1:",
  "    by: user",
  '    at: "2026-10-01T10:00:00.000Z"',
  "  c2:",
  "    body: I can add one from the intro.",
  "    by: AI",
  '    at: "2026-10-01T10:05:00.000Z"',
  "    re: c1",
  "",
].join("\n");

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

// Mirrors PageCard's replyToComment: the reply id joins the root's anchor mark.
function addReplyIdToAnchor(
  doc: JSONContent,
  rootCommentId: string,
  replyId: string,
): JSONContent {
  const next = structuredClone(doc);
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      const commentIds: unknown = mark.attrs?.commentIds;
      if (
        mark.type === "commentRef" &&
        Array.isArray(commentIds) &&
        commentIds.includes(rootCommentId)
      ) {
        mark.attrs = { ...mark.attrs, commentIds: [...commentIds, replyId] };
      }
    }
    for (const child of node.content ?? []) {
      visit(child);
    }
  };

  visit(next);
  return next;
}

// Reads the YAML after the file's last `---` line without going through the
// app's own endmatter detection.
function readFinalYamlBlock(markdown: string): unknown {
  const delimiter = "\n---\n";
  const start = markdown.lastIndexOf(delimiter);
  return start === -1
    ? null
    : parseYaml(markdown.slice(start + delimiter.length));
}

describe("mixed metadata: inline attribute roots with YAML endmatter replies", () => {
  it("reads the final YAML block as endmatter and threads its replies under the inline roots", () => {
    const { comments, endmatter } = criticMarkdownToEditorState(
      inlineRootsWithEndmatterReplies,
    );

    expect.soft(endmatter, "parsed endmatter").not.toBeNull();
    expect.soft(comments.get("c3"), "reply c3").toMatchObject({
      content: "I added a citation from the 2025 report.",
      authorType: "ai",
      parentCommentId: "c1",
    });
    expect.soft(comments.get("c4"), "reply c4").toMatchObject({
      content: "Yes, confirmed with the team.",
      parentCommentId: "c2",
    });
  });

  it("does not render the review endmatter as a horizontal rule and body text", () => {
    const { html } = criticMarkdownToRenderedHtml(
      inlineRootsWithEndmatterReplies,
    );

    expect.soft(html).not.toContain("<hr");
    expect.soft(html).not.toContain("comments:");
  });

  it("saves an unedited document byte-for-byte", () => {
    const parsed = criticMarkdownToEditorState(inlineRootsWithEndmatterReplies);

    expect(saveLikeTheApp(parsed)).toBe(inlineRootsWithEndmatterReplies);
  });

  it("keeps the attribute block and the endmatter replies when a new reply is saved", () => {
    const parsed = criticMarkdownToEditorState(inlineRootsWithEndmatterReplies);
    const replyText = "Thanks, the 2025 report works for me.";
    const reply = createCriticComment(
      {
        parentCommentId: "c1",
        content: replyText,
        createdAt: "2026-10-02T09:00:00.000Z",
      },
      { existingComments: parsed.comments.values() },
    );

    const output = saveLikeTheApp(
      parsed,
      addReplyIdToAnchor(parsed.doc, "c1", reply.id),
      new Map(parsed.comments).set(reply.id, reply),
    );

    expect
      .soft(["c1", "c2", "c3", "c4"], "ids already used by the file")
      .not.toContain(reply.id);
    expect
      .soft(output)
      .toContain(
        '{==an anchored claim==}{>>Needs a citation.<<}{id="c1" by="user" at="2026-10-01T10:00:00.000Z"}',
      );
    expect.soft(readFinalYamlBlock(output), "final YAML block").toMatchObject({
      comments: {
        c3: {
          body: "I added a citation from the 2025 report.",
          by: "AI",
          at: "2026-10-01T11:00:00.000Z",
          re: "c1",
        },
        c4: {
          body: "Yes, confirmed with the team.",
          by: "user",
          at: "2026-10-01T11:05:00.000Z",
          re: "c2",
        },
      },
    });
    expect
      .soft(output.split(replyText).length - 1, "copies of the new reply")
      .toBe(1);
    expect
      .soft(
        criticMarkdownToEditorState(output).comments.get(reply.id),
        "new reply after reload",
      )
      .toMatchObject({ content: replyText, parentCommentId: "c1" });
  });
});

describe("review rail with YAML endmatter replies", () => {
  it("lists an endmatter reply in its root thread when the anchor names only the root", () => {
    const { comments } = criticMarkdownToEditorState(
      referenceRootWithEndmatterReply,
    );

    // The anchor in the file names only c1; the reply points at it through
    // `re: c1` in the endmatter.
    const items = buildCommentThreadRailItems(
      [{ key: "c1", commentIds: ["c1"], anchorTop: 0, anchorBottom: 10 }],
      comments,
    );

    expect(
      items.map(({ rootCommentId, commentIds }) => ({
        rootCommentId,
        commentIds,
      })),
    ).toEqual([{ rootCommentId: "c1", commentIds: ["c1", "c2"] }]);
  });

  it("lists endmatter replies under inline attribute root comments", () => {
    const { comments } = criticMarkdownToEditorState(
      inlineRootsWithEndmatterReplies,
    );

    const items = buildCommentThreadRailItems(
      [
        { key: "c1", commentIds: ["c1"], anchorTop: 0, anchorBottom: 10 },
        { key: "c2", commentIds: ["c2"], anchorTop: 40, anchorBottom: 50 },
      ],
      comments,
    );

    expect(
      items.map(({ rootCommentId, commentIds }) => ({
        rootCommentId,
        commentIds,
      })),
    ).toEqual([
      { rootCommentId: "c1", commentIds: ["c1", "c3"] },
      { rootCommentId: "c2", commentIds: ["c2", "c4"] },
    ]);
  });
});
