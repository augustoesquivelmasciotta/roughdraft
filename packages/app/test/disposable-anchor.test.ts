import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  type CriticComment,
  criticMarkdownToEditorState,
  disposableAnchorCommentIds,
  editorStateToCriticMarkdown,
  getCommentDescendantIds,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";

// Ported from kudzuweb/roughdraftplus #17 (PR #55): a comment flagged
// `anchor="disposable"` marks its anchor text as filler written only to carry
// the thread, and clearing that thread removes the text with it. This fork
// keeps the deleted thread's record (with its anchor text) in the endmatter
// `deleted` list, which the app writes; these tests drive the editor command.

const flagged =
  'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z" anchor="disposable"}\n\nClosing paragraph.\n';
const plain = flagged.replace(' anchor="disposable"', "");
const withReply = flagged.replace(
  'anchor="disposable"}',
  'anchor="disposable"}{>>Free tier first.<<}{id="c2" by="user" at="2024-01-15T10:31:00.000Z" re="c1"}',
);

function clear(
  input: string,
  pick: (comments: Map<string, CriticComment>) => string[],
) {
  const { doc, comments } = criticMarkdownToEditorState(input);
  const removedIds = pick(comments);
  const editor = new Editor({
    extensions: createEditorExtensions(""),
    content: doc,
  });

  try {
    editor.commands.removeCommentIds(removedIds, {
      disposableCommentIds: disposableAnchorCommentIds(removedIds, comments),
    });
    const nextComments = new Map(comments);
    for (const id of removedIds) nextComments.delete(id);
    return editorStateToCriticMarkdown(editor.getJSON(), nextComments);
  } finally {
    editor.destroy();
  }
}

const thread = (id: string) => (comments: Map<string, CriticComment>) => [
  id,
  ...getCommentDescendantIds(id, comments),
];

describe("disposable anchors", () => {
  it("round-trips the flag", () => {
    const { doc, comments } = criticMarkdownToEditorState(flagged);

    expect(disposableAnchorCommentIds(["c1"], comments)).toEqual(["c1"]);
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(flagged);
  });

  it("removes a flagged anchor with its thread and keeps an unflagged one as prose", () => {
    expect(clear(flagged, thread("c1"))).toBe(
      "Intro paragraph.\n\nClosing paragraph.\n",
    );
    expect(clear(plain, thread("c1"))).toBe(
      "Intro paragraph.\n\nPlaceholder for the pricing decision.\n\nClosing paragraph.\n",
    );
  });

  it("removes the anchor when the flagged thread is cleared with its reply", () => {
    expect(clear(withReply, thread("c1"))).toBe(
      "Intro paragraph.\n\nClosing paragraph.\n",
    );
  });

  it("keeps a flagged anchor while any comment still references it", () => {
    expect(clear(withReply, () => ["c2"])).toBe(
      'Intro paragraph.\n\n{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2024-01-15T10:30:00.000Z" anchor="disposable"}\n\nClosing paragraph.\n',
    );
  });

  it("removes a flagged anchor that spans a soft line break", () => {
    const wrapped = flagged.replace(
      "pricing decision.",
      "pricing decision,\nwritten only to carry this thread.",
    );

    expect(clear(wrapped, thread("c1"))).toBe(
      "Intro paragraph.\n\nClosing paragraph.\n",
    );
  });

  it("ignores the flag in endmatter, where it cannot be written", () => {
    const referenced = [
      "Intro paragraph.",
      "",
      "{==Placeholder text.==}{>>Which tier?<<}{#c1}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: AI",
      '    at: "2024-01-15T10:30:00.000Z"',
      "    anchor: disposable",
      "",
    ].join("\n");
    const { comments } = criticMarkdownToEditorState(referenced);

    expect(disposableAnchorCommentIds(["c1"], comments)).toEqual([]);
  });
});
