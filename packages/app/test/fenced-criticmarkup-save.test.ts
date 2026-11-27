import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  createCriticChange,
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";

// Ported from kudzuweb/roughdraftplus #37 (PR #94): a fenced block that holds
// a comment thread must come back from a save as it was written. A save keeps
// an untouched block's bytes, so each case is checked twice: through the
// normal save and through a rewrite that drops the parser's source snapshot,
// which is what the writer does to a block the reviewer edited.

const anchored =
  '{==anchor==}{>>Note<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}';

const commentEndmatter = [
  "---",
  "comments:",
  "  c1:",
  "    by: AI",
  '    at: "2026-09-05T00:00:00.000Z"',
  "",
].join("\n");

function save(markdown: string): string {
  const { doc, comments } = criticMarkdownToEditorState(markdown);
  return editorStateToCriticMarkdown(doc, comments);
}

function rewrite(markdown: string): string {
  const { doc, comments } = criticMarkdownToEditorState(markdown);
  const { roughdraftSource: _source, ...fresh } = doc as JSONContent & {
    roughdraftSource?: unknown;
  };
  return editorStateToCriticMarkdown(fresh, comments);
}

// A one-time normalization and a compounding corruption look the same after
// one save, so every round is asserted against the text the saves should hold.
function expectSavesToHold(markdown: string, rounds = 4): void {
  for (const write of [save, rewrite]) {
    let saved = markdown;
    for (let round = 1; round <= rounds; round += 1) {
      saved = write(saved);
      expect(saved, `${write.name} ${round}`).toBe(markdown);
    }
  }
}

describe("a fenced block holding CriticMarkup survives a save", () => {
  it("keeps a multi-line fenced block that holds an anchored comment", () => {
    expectSavesToHold(
      ["```text", "first line", anchored, "", "last line", "```", ""].join(
        "\n",
      ),
    );
  });

  it("keeps the comment inside a fenced block on the review rail", () => {
    const { comments } = criticMarkdownToEditorState(
      ["```text", "first line", anchored, "", "last line", "```", ""].join(
        "\n",
      ),
    );

    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      content: "Note",
      authorId: "user",
    });
  });

  it("keeps a multi-line fenced block that holds a literal suggestion", () => {
    expectSavesToHold(
      [
        "```md",
        "first line",
        "{++inserted++}",
        "{--deleted--}",
        "{~~old~>new~~}",
        "",
        "last line",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("grows the fence around an example that opens a fence of its own", () => {
    expectSavesToHold(
      [
        "````md",
        "Documenting a fence:",
        anchored,
        "",
        "```text",
        "inner",
        "```",
        "````",
        "",
        "Prose after the fence.",
        "",
      ].join("\n"),
    );
  });

  it("grows a three-backtick fence when its content opens a fence", () => {
    // The source fence is too short for its own content: the inner opener
    // closes it. Rewriting the block must not write it back that way.
    const markdown = ["````md", anchored, "```", "````", ""].join("\n");
    const { doc, comments } = criticMarkdownToEditorState(markdown);
    const { roughdraftSource: _source, ...fresh } = doc as JSONContent & {
      roughdraftSource?: unknown;
    };
    const visit = (node: JSONContent) => {
      if (node.type === "codeBlock" && node.attrs) {
        node.attrs = { ...node.attrs, fence: "```" };
      }
      for (const child of node.content ?? []) visit(child);
    };
    visit(fresh);

    const saved = editorStateToCriticMarkdown(fresh, comments);
    expect(saved.startsWith("````md\n")).toBe(true);
    expect(save(saved)).toBe(saved);
    expect(criticMarkdownToEditorState(saved).comments.has("c1")).toBe(true);
  });

  // An untouched fence keeps its trailing blank lines. Rewritten, each save
  // drops one, as for a plain fence, so the drift spans two rounds and rounds
  // three and four prove it stopped.
  it("settles a rewritten fence's trailing blank lines and then holds", () => {
    const markdown = [
      "```text",
      "code",
      anchored,
      "",
      "",
      "```",
      "",
      "Prose after.",
      "",
    ].join("\n");
    const settled = [
      "```text",
      "code",
      anchored,
      "```",
      "",
      "Prose after.",
      "",
    ].join("\n");

    expect(save(markdown)).toBe(markdown);
    let saved = markdown;
    for (let round = 1; round <= 4; round += 1) {
      saved = rewrite(saved);
      if (round >= 2) expect(saved, `rewrite ${round}`).toBe(settled);
    }
  });

  it("keeps a fenced block whose comment metadata lives in the endmatter", () => {
    expectSavesToHold(
      [
        "```text",
        "first line",
        "{==anchor==}{>>Note<<}{#c1}",
        "",
        "last line",
        "```",
        "",
        commentEndmatter,
      ].join("\n"),
    );
  });

  // Parsing never puts a change mark inside a fence, so this state is only
  // reachable by editing one there, and the editor commands are what build it.
  it("keeps both halves of a multi-line substitution inside a fenced block", () => {
    const input = [
      "```text",
      "before",
      "old one",
      "old twonew one",
      "new two",
      "after",
      "```",
      "",
    ].join("\n");
    const { doc, comments } = criticMarkdownToEditorState(input);
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: doc,
    });

    try {
      const text = editor.state.doc.textBetween(
        0,
        editor.state.doc.content.size,
        "\n",
      );
      const oldStart = text.indexOf("old one");
      const boundary = text.indexOf("new one");
      const newEnd = text.indexOf("\nafter");
      const shared = {
        changeId: "s1",
        createdAt: "2026-01-01T00:00:00.000Z",
        author: "user",
      };

      editor.commands.setTextSelection({
        from: oldStart + 1,
        to: boundary + 1,
      });
      editor.commands.setCriticChange(
        createCriticChange("substitution-old", shared),
      );
      editor.commands.setTextSelection({ from: boundary + 1, to: newEnd + 1 });
      editor.commands.setCriticChange(
        createCriticChange("substitution-new", shared),
      );

      const saved = editorStateToCriticMarkdown(editor.getJSON(), comments);
      expect(saved).toMatch(
        /^```text\nbefore\n\{~~old one\nold two~>new one\nnew two~~\}\{[^}\n]*\}\nafter\n```\n$/,
      );
    } finally {
      editor.destroy();
    }
  });
});
