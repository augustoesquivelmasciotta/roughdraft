import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";

let editor: Editor | null = null;

function roundTrip(markdown: string) {
  const parsed = criticMarkdownToEditorState(markdown);
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createEditorExtensions(""),
    content: parsed.doc,
  });
  const saved = editorStateToCriticMarkdown(editor.getJSON(), parsed.comments, {
    source: parsed.source,
  });
  return { element, saved };
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

describe("blocks indented under a list item", () => {
  const pickOne = [
    "1. **Which one?**",
    "",
    "    Picture this: a paragraph.",
    "",
    "    Pick one (mark only one)",
    "    - [ ] **Option one.** First.",
    "    - [ ] **Option two.** Second.",
    "",
    "2. **Next?**",
    "",
    "    Pick one (mark only one)",
    "    - [ ] **Yes.**",
    "    - [ ] **No.**",
    "",
  ].join("\n");

  it("renders the paragraph and task list inside the item, not as code", () => {
    const { element, saved } = roundTrip(pickOne);

    expect(element.querySelector("pre")).toBeNull();
    // Four task items, every one inside the numbered item's own list.
    const checkboxes = [
      ...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    expect(checkboxes).toHaveLength(4);
    expect(
      checkboxes.every((checkbox) => checkbox.closest("ol > li ul li")),
    ).toBe(true);
    expect(saved).not.toContain("```");
    expect(saved).toMatch(/^\s+- \[ \] \*\*Option one\.\*\* First\.$/m);
    expect(saved).not.toMatch(/^- \[ \] \*\*Option one/m);
  });

  it("keeps a real indented code block inside a list item", () => {
    const markdown = [
      "- item",
      "",
      "      real code",
      "      more code",
      "",
      "After.",
      "",
    ].join("\n");
    const { saved } = roundTrip(markdown);

    expect(saved).toBe(markdown);
  });

  it("keeps a numbered item's deep indented code block", () => {
    const markdown = ["1. item", "", "       real code", "", "After.", ""].join(
      "\n",
    );

    expect(roundTrip(markdown).saved).toBe(markdown);
  });
});
