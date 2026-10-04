import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { foldingPluginKey, revealFoldedContent } from "../src/editor-folding";
import { createEditorExtensions } from "../src/editor-extensions";

const longDiff = Array.from({ length: 45 }, (_, index) => `+line ${index + 1}`);
const markdown = [
  "# Review",
  "",
  "Intro.",
  "",
  "## Changelog",
  "",
  "- First change",
  "",
  "### Details",
  "",
  "Nested text.",
  "",
  "## Diff",
  "",
  "```diff",
  ...longDiff,
  "```",
  "",
  "```js",
  "short();",
  "```",
  "",
].join("\n");

let editor: Editor | null = null;

function mountEditor() {
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

function classesOf(selector: string) {
  return [...(editor?.view.dom.querySelectorAll<HTMLElement>(selector) ?? [])];
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

describe("section and code block folding", () => {
  it("starts long code blocks folded and leaves short ones alone", () => {
    mountEditor();

    const toggles = classesOf('[data-testid="code-block-fold-toggle"]');
    expect(toggles.map((toggle) => toggle.textContent)).toEqual([
      "Show all 45 lines",
    ]);
    expect(classesOf("pre.rd-code-folded")).toHaveLength(1);
  });

  it("folds the section under a heading down to the next heading of the same level", () => {
    const { editor: mounted } = mountEditor();
    const changelog = classesOf("h2").find((heading) =>
      heading.textContent?.includes("Changelog"),
    );
    const toggle = changelog?.querySelector<HTMLButtonElement>(
      '[data-testid="heading-fold-toggle"]',
    );

    toggle?.click();

    const hidden = classesOf(".rd-folded-away").map((element) =>
      element.textContent?.trim(),
    );
    expect(hidden).toEqual(["First change", "Details", "Nested text."]);
    expect(
      foldingPluginKey.getState(mounted.state)?.foldedHeadings,
    ).toHaveLength(1);
  });

  it("never changes the document, so folding is not saved", () => {
    const { editor: mounted, parsed } = mountEditor();
    const foldTransactions: boolean[] = [];
    mounted.on("transaction", ({ transaction }) => {
      if (transaction.getMeta(foldingPluginKey)) {
        foldTransactions.push(transaction.docChanged);
      }
    });

    classesOf('[data-testid="heading-fold-toggle"]')[1]?.click();
    classesOf('[data-testid="code-block-fold-toggle"]')[0]?.click();

    expect(foldTransactions).toEqual([false, false]);
    expect(
      editorStateToCriticMarkdown(mounted.getJSON(), parsed.comments, {
        source: parsed.source,
      }),
    ).toBe(markdown);
  });

  it("reveals folded content that navigation needs to show", () => {
    const { editor: mounted } = mountEditor();
    classesOf('[data-testid="heading-fold-toggle"]')[1]?.click();
    const nested = classesOf("p").find((paragraph) =>
      paragraph.textContent?.includes("Nested text."),
    );
    expect(nested?.classList.contains("rd-folded-away")).toBe(true);

    if (nested) revealFoldedContent(mounted, nested);

    expect(classesOf(".rd-folded-away")).toHaveLength(0);
  });
});
