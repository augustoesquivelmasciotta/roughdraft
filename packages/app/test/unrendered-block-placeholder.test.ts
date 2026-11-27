import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";
import {
  encodeRawMarkdownBlock,
  protectRichTextRoundTripMarkdown,
  rawMarkdownBlockAttribute,
  rawMarkdownBlockTypeAttribute,
} from "../src/markdown";

let editor: Editor | null = null;

function mount(
  content: string | ReturnType<typeof criticMarkdownToEditorState>["doc"],
) {
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createEditorExtensions(""),
    content,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

describe("raw block types", () => {
  it("tags each protected block with the construct it keeps", () => {
    const protectedMarkdown = protectRichTextRoundTripMarkdown(
      [
        "| Flag | Meaning |",
        "| --- | --- |",
        "| `a \\| b` | either |",
        "",
        "<details><summary>More</summary>",
        "",
        "Hidden text.",
        "",
        "</details>",
        "",
        "<!-- a source note -->",
        "",
        "- item",
        "",
        "    indented code",
        "",
      ].join("\n"),
    );

    const types = [
      ...protectedMarkdown.matchAll(
        new RegExp(`${rawMarkdownBlockTypeAttribute}="([^"]+)"`, "g"),
      ),
    ].map((match) => match[1]);
    // In document order.
    expect(types).toEqual([
      "table",
      "details",
      "html-comment",
      "indented-code",
    ]);
  });
});

describe("unrendered block placeholder", () => {
  it("shows a box naming the block type when the preview comes out empty", () => {
    const rawMarkdown = "<style>p { color: red }</style>\n";
    const view = mount(
      `<p>Before.</p><div ${rawMarkdownBlockAttribute}="${encodeRawMarkdownBlock(
        rawMarkdown,
      )}" ${rawMarkdownBlockTypeAttribute}="table"></div><p>After.</p>`,
    ).view;

    const placeholder = view.dom.querySelector<HTMLElement>(
      '[data-testid="unrendered-block-placeholder"]',
    );
    expect(placeholder).not.toBeNull();
    expect(placeholder?.dataset.blockType).toBe("table");
    expect(placeholder?.getAttribute("role")).toBe("note");
    expect(placeholder?.textContent).toContain("Table not rendered");
    expect(placeholder?.textContent).toContain("switch to code view");
    expect(view.dom.textContent).toContain("After.");
  });

  it("keeps the block's markdown exactly when the placeholder is shown", () => {
    const markdown = [
      "# Doc",
      "",
      "| Flag | Meaning |",
      "| --- | --- |",
      "| `a \\| b` | either |",
      "",
      "After the table.",
      "",
    ].join("\n");
    const parsed = criticMarkdownToEditorState(markdown);
    const view = mount(parsed.doc).view;

    // This table renders in our preview, so no placeholder: the guard only
    // fires when a block cannot be shown.
    expect(
      view.dom.querySelector('[data-testid="unrendered-block-placeholder"]'),
    ).toBeNull();
    expect(
      view.dom
        .querySelector('[data-testid="raw-markdown-block"]')
        ?.getAttribute(rawMarkdownBlockTypeAttribute),
    ).toBe("table");
    expect(
      editorStateToCriticMarkdown(editor?.getJSON() ?? {}, parsed.comments, {
        source: parsed.source,
      }),
    ).toBe(markdown);
  });

  it("keeps HTML comments hidden: they are source-only notes, not a failure", () => {
    const parsed = criticMarkdownToEditorState(
      "# Doc\n\n<!-- a source note -->\n\nText.\n",
    );
    const view = mount(parsed.doc).view;

    expect(
      view.dom.querySelector('[data-testid="unrendered-block-placeholder"]'),
    ).toBeNull();
    expect(
      view.dom
        .querySelector('[data-testid="raw-markdown-block"]')
        ?.classList.contains("rd-raw-block--hidden"),
    ).toBe(true);
  });
});
