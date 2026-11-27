import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AllSelection, NodeSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import {
  createEditorExtensions,
  rawMarkdownBlockGuardPluginKey,
} from "../src/editor-extensions";

const protectedTableMarkdown = [
  "Flags in use:",
  "",
  "| Flag | Meaning |",
  "| --- | --- |",
  "| `a \\| b` | either |",
  "",
  "Trailing paragraph.",
  "",
  "Another paragraph.",
  "",
].join("\n");

const twinTablesMarkdown = [
  "First.",
  "",
  "| Flag | Meaning |",
  "| --- | --- |",
  "| `a \\| b` | either |",
  "",
  "Between.",
  "",
  "| Flag | Meaning |",
  "| --- | --- |",
  "| `a \\| b` | either |",
  "",
  "Last.",
  "",
].join("\n");

const plainMarkdown = ["First paragraph.", "", "Second paragraph.", ""].join(
  "\n",
);

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

function createEditor(markdown: string): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);

  const editor = new Editor({
    element,
    extensions: createEditorExtensions(""),
    content: criticMarkdownToEditorState(markdown).doc,
  });
  editors.push(editor);

  return editor;
}

/**
 * Helper: build an editor holding one protected table between prose, the
 * document shape a rich-text reader sees for Markdown that cannot round-trip.
 */
function createEditorWithProtectedTable(): Editor {
  return createEditor(protectedTableMarkdown);
}

function findRawMarkdownBlockPos(editor: Editor): number {
  let found: number | null = null;
  editor.state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (found === null && node.type.name === "rawMarkdownBlock") {
      found = pos;
    }
    return found === null;
  });

  if (found === null) {
    throw new Error("Expected the document to hold a rawMarkdownBlock");
  }

  return found;
}

function blockRange(editor: Editor): { from: number; to: number } {
  const from = findRawMarkdownBlockPos(editor);
  const node = editor.state.doc.nodeAt(from);
  if (!node) throw new Error("Expected a rawMarkdownBlock at that position");
  return { from, to: from + node.nodeSize };
}

function allRawMarkdownBlockPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (node.type.name === "rawMarkdownBlock") positions.push(pos);
    return true;
  });
  return positions;
}

/** The block's own range, plus the ranges of the nodes touching each side. */
function neighbourRanges(editor: Editor) {
  const { from, to } = blockRange(editor);
  const $before = editor.state.doc.resolve(from);
  const nodeBefore = $before.nodeBefore;
  const nodeAfter = editor.state.doc.resolve(to).nodeAfter;
  if (!nodeBefore || !nodeAfter) {
    throw new Error("Expected prose on both sides of the placeholder");
  }
  return {
    before: { from: from - nodeBefore.nodeSize, to: from },
    after: { from: to, to: to + nodeAfter.nodeSize },
  };
}

function selectPlaceholder(editor: Editor): void {
  const { state } = editor.view;
  editor.view.dispatch(
    state.tr.setSelection(
      NodeSelection.create(state.doc, findRawMarkdownBlockPos(editor)),
    ),
  );
}

/**
 * Helper: press one key on the editor's own DOM node, so the keystroke runs
 * through ProseMirror's keymap the way a reader's Backspace does.
 */
function pressKey(editor: Editor, key: string): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function toMarkdown(editor: Editor): string {
  return editorStateToCriticMarkdown(editor.getJSON(), new Map());
}

function countRawMarkdownBlocks(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node: ProseMirrorNode) => {
    if (node.type.name === "rawMarkdownBlock") count += 1;
    return true;
  });
  return count;
}

function refusedPos(editor: Editor): number | null {
  return (
    rawMarkdownBlockGuardPluginKey.getState(editor.state)?.refusedPos ?? null
  );
}

describe("a transaction that would drop a protected block", () => {
  it("is refused when it deletes the block on its own", () => {
    const editor = createEditorWithProtectedTable();
    const { from, to } = blockRange(editor);

    editor.view.dispatch(editor.state.tr.delete(from, to));

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("is refused when it deletes a range that spans the block", () => {
    const editor = createEditorWithProtectedTable();
    const { to } = blockRange(editor);

    editor.view.dispatch(editor.state.tr.delete(1, to + 1));

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("is refused when it replaces the whole document", () => {
    const editor = createEditorWithProtectedTable();
    const { state } = editor.view;

    editor.view.dispatch(
      state.tr.setSelection(new AllSelection(state.doc)).deleteSelection(),
    );

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("is refused when Backspace lands on the selected placeholder", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    pressKey(editor, "Backspace");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("is refused when Delete lands on the selected placeholder", () => {
    const editor = createEditorWithProtectedTable();
    selectPlaceholder(editor);

    pressKey(editor, "Delete");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("notes the refusal on the block that would have gone", async () => {
    const editor = createEditorWithProtectedTable();
    const { from, to } = blockRange(editor);
    expect(refusedPos(editor)).toBe(null);

    editor.view.dispatch(editor.state.tr.delete(from, to));
    await Promise.resolve();

    expect(refusedPos(editor)).toBe(from);
  });

  it("clears the refusal note once the reader moves the selection", async () => {
    const editor = createEditorWithProtectedTable();
    const { from, to } = blockRange(editor);
    editor.view.dispatch(editor.state.tr.delete(from, to));
    await Promise.resolve();

    editor.commands.setTextSelection(1);

    expect(refusedPos(editor)).toBe(null);
  });
});

describe("a transaction that keeps every protected block", () => {
  it("goes through when it deletes a range holding nothing protected", () => {
    const editor = createEditorWithProtectedTable();
    const { to } = blockRange(editor);
    const before = editor.state.doc.content.size;

    editor.view.dispatch(
      editor.state.tr.delete(to + 1, editor.state.doc.content.size - 1),
    );

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(editor.state.doc.content.size).toBeLessThan(before);
    expect(refusedPos(editor)).toBe(null);
  });

  it("goes through when the document holds nothing protected", () => {
    const editor = createEditor(plainMarkdown);

    editor.view.dispatch(
      editor.state.tr.delete(1, editor.state.doc.content.size - 1),
    );

    expect(editor.state.doc.textContent).not.toContain("First paragraph.");
  });

  it("goes through for a caret typing beside the placeholder", () => {
    const editor = createEditorWithProtectedTable();
    editor.commands.setTextSelection(1);

    editor.view.dispatch(editor.state.tr.insertText("x", 1, 1));

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(editor.state.doc.textContent).toContain("xFlags in use:");
  });

  it("goes through when a document is loaded over one holding a block", () => {
    const editor = createEditorWithProtectedTable();

    editor.commands.setContent(criticMarkdownToEditorState(plainMarkdown).doc, {
      emitUpdate: false,
    });

    expect(countRawMarkdownBlocks(editor)).toBe(0);
    expect(editor.state.doc.textContent).toContain("First paragraph.");
  });

  it("goes through when undo removes a block that was just added", () => {
    const editor = createEditor(plainMarkdown);
    const { state } = editor.view;
    const blockType = state.schema.nodes.rawMarkdownBlock;

    editor.view.dispatch(
      state.tr.insert(
        0,
        blockType.create({
          rawMarkdown: "%7C%20a%20%7C%0A",
          blockType: "table",
        }),
      ),
    );
    expect(countRawMarkdownBlocks(editor)).toBe(1);

    editor.commands.undo();

    // Undo is the second of the two exemptions. Without it the guard would
    // refuse this, and a reader could never take back an inserted block.
    expect(countRawMarkdownBlocks(editor)).toBe(0);
  });

  it("goes through when a block is replaced by an identical copy", () => {
    const editor = createEditorWithProtectedTable();
    const { from, to } = blockRange(editor);
    const original = editor.state.doc.nodeAt(from);
    if (!original) throw new Error("Expected a block to copy");

    editor.view.dispatch(
      editor.state.tr.replaceWith(
        from,
        to,
        original.type.create(original.attrs),
      ),
    );

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
    expect(refusedPos(editor)).toBe(null);
  });

  it("goes through when a deletion ends exactly at the block's start", () => {
    const editor = createEditorWithProtectedTable();
    const { before } = neighbourRanges(editor);

    editor.view.dispatch(editor.state.tr.delete(before.from, before.to));

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(editor.state.doc.textContent).not.toContain("Flags in use:");
    expect(refusedPos(editor)).toBe(null);
  });

  it("goes through when a deletion starts exactly at the block's end", () => {
    const editor = createEditorWithProtectedTable();
    const { after } = neighbourRanges(editor);

    editor.view.dispatch(editor.state.tr.delete(after.from, after.to));

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(editor.state.doc.textContent).not.toContain("Trailing paragraph.");
    expect(refusedPos(editor)).toBe(null);
  });

  it("goes through when both neighbours go and the block stays", () => {
    const editor = createEditorWithProtectedTable();
    const { before, after } = neighbourRanges(editor);

    editor.view.dispatch(
      editor.state.tr
        .delete(after.from, after.to)
        .delete(before.from, before.to),
    );

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(editor.state.doc.textContent).not.toContain("Flags in use:");
    expect(editor.state.doc.textContent).not.toContain("Trailing paragraph.");
    expect(refusedPos(editor)).toBe(null);
  });

  it("goes through when text replaces a range ending at the block's start", () => {
    const editor = createEditorWithProtectedTable();
    const { before } = neighbourRanges(editor);

    editor.view.dispatch(
      editor.state.tr.insertText("replaced", before.from + 1, before.to - 1),
    );

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(editor.state.doc.textContent).toContain("replaced");
    expect(refusedPos(editor)).toBe(null);
  });
});

describe("the note the refusal leaves", () => {
  it("lands on the first of two identical blocks when that one goes", async () => {
    const editor = createEditor(twinTablesMarkdown);
    const [first, second] = allRawMarkdownBlockPositions(editor);
    expect(second).toBeGreaterThan(first);

    editor.view.dispatch(editor.state.tr.delete(first, first + 1));
    await Promise.resolve();

    expect(refusedPos(editor)).toBe(first);
  });

  it("lands on the second of two identical blocks when that one goes", async () => {
    const editor = createEditor(twinTablesMarkdown);
    const [, second] = allRawMarkdownBlockPositions(editor);

    editor.view.dispatch(editor.state.tr.delete(second, second + 1));
    await Promise.resolve();

    expect(refusedPos(editor)).toBe(second);
  });

  it("is refused when a different block is swapped in where one stood", () => {
    const editor = createEditorWithProtectedTable();
    const { from, to } = blockRange(editor);
    const blockType = editor.state.schema.nodes.rawMarkdownBlock;

    // The extent survives and a protected block still stands here, so only the
    // Markdown it carries says the reader's table went.
    editor.view.dispatch(
      editor.state.tr.replaceWith(
        from,
        to,
        blockType.create({
          rawMarkdown: "%7C%20other%20%7C%0A",
          blockType: "table",
        }),
      ),
    );

    expect(toMarkdown(editor)).toBe(protectedTableMarkdown);
  });

  it("still refuses when one block is dropped and another added", () => {
    const editor = createEditor(twinTablesMarkdown);
    const [first] = allRawMarkdownBlockPositions(editor);
    const blockType = editor.state.schema.nodes.rawMarkdownBlock;
    const twinMarkdown = String(
      editor.state.doc.nodeAt(first)?.attrs.rawMarkdown,
    );

    // The block count is even across this transaction, so counting blocks
    // would wave it through while one of the reader's tables went missing.
    editor.view.dispatch(
      editor.state.tr.delete(first, first + 1).insert(
        0,
        blockType.create({
          rawMarkdown: "%7C%20other%20%7C%0A",
          blockType: "table",
        }),
      ),
    );

    const surviving = allRawMarkdownBlockPositions(editor).map((pos) =>
      String(editor.state.doc.nodeAt(pos)?.attrs.rawMarkdown),
    );
    expect(surviving).toEqual([twinMarkdown, twinMarkdown]);
  });
});

describe("our raw blocks beyond tables", () => {
  const detailsMarkdown = [
    "Intro.",
    "",
    "<details><summary>Changelog</summary>",
    "",
    "- First change",
    "",
    "</details>",
    "",
    "After.",
    "",
  ].join("\n");

  it("refuses to drop a <details> section and keeps its Markdown", () => {
    const editor = createEditor(detailsMarkdown);
    selectPlaceholder(editor);

    pressKey(editor, "Backspace");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(detailsMarkdown);
  });

  it("refuses Backspace at the start of the paragraph right after a <details> section", () => {
    const editor = createEditor(detailsMarkdown);
    const { to } = blockRange(editor);
    editor.commands.setTextSelection(to + 1);

    pressKey(editor, "Backspace");

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(toMarkdown(editor)).toBe(detailsMarkdown);
  });

  it("refuses to drop a hidden HTML comment and shows the note where it sits", async () => {
    const markdown = "Intro.\n\n<!-- a source note -->\n\nAfter.\n";
    const editor = createEditor(markdown);
    const { from, to } = blockRange(editor);

    editor.view.dispatch(editor.state.tr.delete(from, to));
    await Promise.resolve();

    expect(toMarkdown(editor)).toBe(markdown);
    const note = editor.view.dom.querySelector(
      '[data-testid="unrendered-block-deletion-refused"]',
    );
    expect(note?.textContent).toContain(
      "Rich text will not delete this html comment",
    );
  });

  it("tells the reader, moves the caret clear of the block and lets the next character land", async () => {
    const editor = createEditorWithProtectedTable();
    const { to } = blockRange(editor);
    selectPlaceholder(editor);

    pressKey(editor, "Delete");
    await Promise.resolve();

    const note = editor.view.dom.querySelector(
      '[data-testid="unrendered-block-deletion-refused"]',
    );
    expect(note?.textContent).toContain("Rich text will not delete this table");
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(to);

    editor.view.dispatch(editor.state.tr.insertText("x"));

    expect(countRawMarkdownBlocks(editor)).toBe(1);
    expect(editor.state.doc.textContent).toContain("xTrailing paragraph.");
    expect(
      editor.view.dom.querySelector(
        '[data-testid="unrendered-block-deletion-refused"]',
      ),
    ).toBeNull();
  });

  it("marks the block as selected for the reader's next keystroke", () => {
    const editor = createEditorWithProtectedTable();

    selectPlaceholder(editor);

    expect(
      editor.view.dom
        .querySelector('[data-testid="raw-markdown-block"]')
        ?.getAttribute("data-selected"),
    ).toBe("true");
  });
});
