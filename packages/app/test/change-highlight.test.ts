import { Editor } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import {
  baselineTextsFromDoc,
  CHANGE_HIGHLIGHT_DEBOUNCE_MS,
  getChangeHighlightState,
  jumpToChange,
  setChangeBaseline,
  setChangesVisible,
} from "../src/editor-change-highlight";
import { createEditorExtensions } from "../src/editor-extensions";

const baselineMarkdown = [
  "# Plan",
  "",
  "The first paragraph stays exactly the same.",
  "",
  "We will ship the report on Friday afternoon.",
  "",
  "A paragraph that will be removed entirely.",
  "",
  "Closing words.",
  "",
].join("\n");

const currentMarkdown = [
  "# Plan",
  "",
  "The first paragraph stays exactly the same.",
  "",
  "We will ship the report on Monday morning.",
  "",
  "Closing words.",
  "",
  "A brand new paragraph at the end.",
  "",
].join("\n");

let editor: Editor | null = null;

function mountEditor(markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown);
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createEditorExtensions(""),
    content: parsed.doc,
  });
  return { editor, parsed };
}

function baselineTexts(markdown: string, mounted: Editor) {
  const parsed = criticMarkdownToEditorState(markdown);
  return baselineTextsFromDoc(
    ProseMirrorNode.fromJSON(mounted.schema, parsed.doc),
  );
}

function all(selector: string) {
  return [...(editor?.view.dom.querySelectorAll<HTMLElement>(selector) ?? [])];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("change highlighting decorations", () => {
  it("marks changed and new blocks, and leaves unchanged ones alone", () => {
    const { editor: mounted } = mountEditor(currentMarkdown);
    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));

    const marked = all('[data-testid="change-block"]').map((block) => ({
      kind: block.dataset.changeKind,
      text: block.textContent,
    }));
    expect(marked).toEqual([
      {
        kind: "changed",
        text: "We will ship the report on Monday morning.",
      },
      { kind: "added", text: "A brand new paragraph at the end." },
    ]);
    // Unchanged paragraphs carry no decoration.
    const plain = all("p, h1").filter(
      (element) => !element.matches('[data-testid="change-block"]'),
    );
    expect(plain.map((element) => element.textContent)).toEqual([
      "Plan",
      "The first paragraph stays exactly the same.",
      "Closing words.",
    ]);
  });

  it("tints only the changed words of a changed block", () => {
    const { editor: mounted } = mountEditor(currentMarkdown);
    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));

    const changed = all(
      '[data-change-kind="changed"] [data-testid="change-word"]',
    );
    expect(changed.map((word) => word.textContent).join("")).toBe(
      "Monday morning.",
    );
  });

  it("puts a marker where a block was removed", () => {
    const { editor: mounted } = mountEditor(currentMarkdown);
    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));

    const markers = all('[data-testid="change-removed-marker"]');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.title).toBe(
      "Removed: A paragraph that will be removed entirely.",
    );
    expect(
      getChangeHighlightState(mounted)?.changes.map((c) => c.kind),
    ).toEqual(["changed", "removed", "added"]);
  });

  it("shows nothing when the baseline equals the document", () => {
    const { editor: mounted } = mountEditor(baselineMarkdown);
    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));

    expect(all('[data-testid="change-block"]')).toHaveLength(0);
    expect(all('[data-testid="change-removed-marker"]')).toHaveLength(0);
    expect(getChangeHighlightState(mounted)?.changes).toEqual([]);
  });

  it("does not count a new comment as a change", () => {
    const withComment = baselineMarkdown.replace(
      "Closing words.",
      "{==Closing words.==}{>>Why this?<<}{#c1}",
    );
    const { editor: mounted } = mountEditor(withComment);
    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));

    expect(getChangeHighlightState(mounted)?.changes).toEqual([]);
  });

  it("never edits the document: not dirty, not saved", () => {
    const { editor: mounted, parsed } = mountEditor(currentMarkdown);
    const updates = vi.fn();
    mounted.on("update", updates);
    const save = () =>
      editorStateToCriticMarkdown(mounted.getJSON(), parsed.comments, {
        source: parsed.source,
      });
    const before = save();

    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));
    expect(all('[data-testid="change-block"]').length).toBeGreaterThan(0);
    const withHighlight = save();
    setChangesVisible(mounted, false);
    jumpToChange(mounted, 1);

    expect(withHighlight).toBe(before);
    expect(save()).toBe(before);
    expect(mounted.getHTML()).not.toContain("rd-change");
    expect(updates).not.toHaveBeenCalled();
  });

  it("hides the colors with the toggle but keeps the count", () => {
    const { editor: mounted } = mountEditor(currentMarkdown);
    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));

    setChangesVisible(mounted, false);
    expect(all('[data-testid="change-block"]')).toHaveLength(0);
    expect(getChangeHighlightState(mounted)?.changes).toHaveLength(3);

    setChangesVisible(mounted, true);
    expect(all('[data-testid="change-block"]')).toHaveLength(2);
  });

  it("jumps between changes in document order, wrapping around", () => {
    const { editor: mounted } = mountEditor(currentMarkdown);
    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));

    expect(jumpToChange(mounted, 1)).toBe(0);
    expect(all('[data-change-current="true"]')).toHaveLength(1);
    expect(all('[data-change-current="true"]')[0]?.textContent).toContain(
      "Monday",
    );
    expect(jumpToChange(mounted, 1)).toBe(1);
    expect(all('[data-change-current="true"]')[0]?.dataset.testid).toBe(
      "change-removed-marker",
    );
    expect(jumpToChange(mounted, 1)).toBe(2);
    expect(jumpToChange(mounted, 1)).toBe(0);
    expect(jumpToChange(mounted, -1)).toBe(2);
  });

  it("recomputes, debounced, when the document is edited", () => {
    const { editor: mounted } = mountEditor(baselineMarkdown);
    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));
    expect(getChangeHighlightState(mounted)?.changes).toEqual([]);

    mounted.commands.insertContentAt(
      mounted.state.doc.content.size,
      "<p>Typed after opening.</p>",
    );
    // The colors catch up after the debounce, not on every keystroke.
    expect(getChangeHighlightState(mounted)?.changes).toEqual([]);
    vi.advanceTimersByTime(CHANGE_HIGHLIGHT_DEBOUNCE_MS + 10);

    expect(
      getChangeHighlightState(mounted)?.changes.map((c) => c.kind),
    ).toEqual(["added"]);
    expect(
      all('[data-testid="change-block"]').map((block) => block.textContent),
    ).toEqual(["Typed after opening."]);
  });

  it("clears everything when the baseline goes away", () => {
    const { editor: mounted } = mountEditor(currentMarkdown);
    setChangeBaseline(mounted, baselineTexts(baselineMarkdown, mounted));
    setChangeBaseline(mounted, null);

    expect(all('[data-testid="change-block"]')).toHaveLength(0);
    expect(getChangeHighlightState(mounted)?.changes).toEqual([]);
  });
});
