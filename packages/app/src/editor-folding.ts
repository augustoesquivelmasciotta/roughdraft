import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/**
 * View-only folding for long review documents: collapse the section under a
 * heading, and collapse long fenced code blocks (diffs, changelogs). Folding
 * never changes the document, so it is never saved and never marks the
 * document dirty.
 */

/** Code blocks longer than this get a fold control and start folded. */
export const LONG_CODE_BLOCK_LINE_COUNT = 20;

interface FoldingState {
  /** Positions of top-level headings whose section is folded. */
  foldedHeadings: number[];
  /** Code block position -> folded, for blocks the reader toggled. */
  codeBlockOverrides: Map<number, boolean>;
  decorations: DecorationSet;
}

type FoldingMeta =
  | { type: "toggle-heading"; pos: number }
  | { type: "toggle-code-block"; pos: number }
  | { type: "reveal"; pos: number };

export const foldingPluginKey = new PluginKey<FoldingState>(
  "roughdraftFolding",
);

const lineCountCache = new WeakMap<ProseMirrorNode, number>();

function codeBlockLineCount(node: ProseMirrorNode): number {
  const cached = lineCountCache.get(node);
  if (cached !== undefined) return cached;

  const count = node.textContent.split("\n").length;
  lineCountCache.set(node, count);
  return count;
}

function isLongCodeBlock(node: ProseMirrorNode) {
  return codeBlockLineCount(node) > LONG_CODE_BLOCK_LINE_COUNT;
}

function isCodeBlockFolded(
  node: ProseMirrorNode,
  pos: number,
  overrides: ReadonlyMap<number, boolean>,
) {
  return overrides.get(pos) ?? isLongCodeBlock(node);
}

function preventEditorFocus(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

function topLevelPosForDom(view: EditorView, element: Node): number | null {
  try {
    const pos = view.posAtDOM(element, 0);
    const $pos = view.state.doc.resolve(pos);
    return $pos.depth === 0 ? pos : $pos.before(1);
  } catch {
    return null;
  }
}

function createHeadingToggle(view: EditorView, folded: boolean) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `rd-fold-toggle rd-heading-fold-toggle${
    folded ? " rd-fold-toggle--folded" : ""
  }`;
  button.contentEditable = "false";
  button.dataset.testid = "heading-fold-toggle";
  button.setAttribute("aria-expanded", folded ? "false" : "true");
  button.setAttribute(
    "aria-label",
    folded ? "Expand this section" : "Collapse this section",
  );
  button.title = folded ? "Expand section" : "Collapse section";
  button.addEventListener("mousedown", preventEditorFocus);
  button.addEventListener("click", (event) => {
    preventEditorFocus(event);
    const pos = topLevelPosForDom(view, button);
    if (pos === null) return;
    view.dispatch(
      view.state.tr.setMeta(foldingPluginKey, {
        type: "toggle-heading",
        pos,
      } satisfies FoldingMeta),
    );
  });
  return button;
}

function createCodeBlockToggle(
  view: EditorView,
  folded: boolean,
  lineCount: number,
) {
  const wrapper = document.createElement("div");
  wrapper.className = "rd-code-fold-bar";
  wrapper.contentEditable = "false";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "rd-fold-toggle rd-code-fold-toggle";
  button.dataset.testid = "code-block-fold-toggle";
  button.setAttribute("aria-expanded", folded ? "false" : "true");
  button.textContent = folded
    ? `Show all ${lineCount} lines`
    : `Collapse ${lineCount} lines`;
  button.addEventListener("mousedown", preventEditorFocus);
  button.addEventListener("click", (event) => {
    preventEditorFocus(event);
    const widgetPos = topLevelPosForDom(view, wrapper);
    if (widgetPos === null) return;
    // The bar sits right after its code block.
    const $pos = view.state.doc.resolve(widgetPos);
    const codeBlock = $pos.nodeBefore;
    if (codeBlock?.type.name !== "codeBlock") return;
    view.dispatch(
      view.state.tr.setMeta(foldingPluginKey, {
        type: "toggle-code-block",
        pos: widgetPos - codeBlock.nodeSize,
      } satisfies FoldingMeta),
    );
  });

  wrapper.append(button);
  return wrapper;
}

function buildDecorations(
  doc: ProseMirrorNode,
  foldedHeadings: number[],
  codeBlockOverrides: ReadonlyMap<number, boolean>,
): DecorationSet {
  const decorations: Decoration[] = [];
  const folded = new Set(foldedHeadings);
  let hiddenUntilLevel: number | null = null;

  doc.forEach((node, pos) => {
    if (node.type.name === "heading") {
      const level = Number(node.attrs.level) || 1;
      if (hiddenUntilLevel !== null && level <= hiddenUntilLevel) {
        hiddenUntilLevel = null;
      }
      if (hiddenUntilLevel !== null) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: "rd-folded-away",
          }),
        );
        return;
      }

      const isFolded = folded.has(pos);
      decorations.push(
        Decoration.widget(
          pos + 1,
          (view) => createHeadingToggle(view, isFolded),
          {
            side: -1,
            ignoreSelection: true,
            key: `heading-fold-${isFolded ? "folded" : "open"}`,
          },
        ),
      );
      if (isFolded) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: "rd-heading-folded",
          }),
        );
        hiddenUntilLevel = level;
      }
      return;
    }

    if (hiddenUntilLevel !== null) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: "rd-folded-away" }),
      );
      return;
    }

    if (node.type.name !== "codeBlock") return;
    if (!isLongCodeBlock(node) && !codeBlockOverrides.has(pos)) return;

    const lineCount = codeBlockLineCount(node);
    const isFolded = isCodeBlockFolded(node, pos, codeBlockOverrides);
    if (isFolded) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: "rd-code-folded",
        }),
      );
    }
    decorations.push(
      Decoration.widget(
        pos + node.nodeSize,
        (view) => createCodeBlockToggle(view, isFolded, lineCount),
        {
          side: -1,
          ignoreSelection: true,
          key: `code-fold-${isFolded ? "folded" : "open"}-${lineCount}`,
        },
      ),
    );
  });

  return DecorationSet.create(doc, decorations);
}

function isTopLevelNodeOfType(
  doc: ProseMirrorNode,
  pos: number,
  type: string,
): boolean {
  if (pos < 0 || pos >= doc.content.size) return false;
  const $pos = doc.resolve(pos);
  return $pos.depth === 0 && doc.nodeAt(pos)?.type.name === type;
}

/** Folded headings whose section contains `pos`. */
function headingsFoldingPos(
  doc: ProseMirrorNode,
  foldedHeadings: number[],
  pos: number,
): number[] {
  const containing: number[] = [];
  const folded = new Set(foldedHeadings);
  let openSections: Array<{ pos: number; level: number }> = [];

  doc.forEach((node, nodePos) => {
    if (nodePos > pos) return;
    if (node.type.name === "heading") {
      const level = Number(node.attrs.level) || 1;
      openSections = openSections.filter((section) => section.level < level);
      openSections.push({ pos: nodePos, level });
    }
  });

  for (const section of openSections) {
    if (folded.has(section.pos) && section.pos !== pos) {
      containing.push(section.pos);
    }
  }

  return containing;
}

export const SectionFolding = Extension.create({
  name: "sectionFolding",

  addProseMirrorPlugins() {
    return [
      new Plugin<FoldingState>({
        key: foldingPluginKey,
        state: {
          init: (_, state) => ({
            foldedHeadings: [],
            codeBlockOverrides: new Map(),
            decorations: buildDecorations(state.doc, [], new Map()),
          }),
          apply: (tr, value, _oldState, newState) => {
            const meta = tr.getMeta(foldingPluginKey) as
              | FoldingMeta
              | undefined;
            if (!meta && !tr.docChanged) return value;

            let foldedHeadings = value.foldedHeadings;
            let codeBlockOverrides = value.codeBlockOverrides;

            if (tr.docChanged) {
              foldedHeadings = foldedHeadings
                .map((pos) => tr.mapping.map(pos))
                .filter((pos) =>
                  isTopLevelNodeOfType(newState.doc, pos, "heading"),
                );
              codeBlockOverrides = new Map(
                [...codeBlockOverrides]
                  .map(
                    ([pos, isFolded]) =>
                      [tr.mapping.map(pos), isFolded] as const,
                  )
                  .filter(([pos]) =>
                    isTopLevelNodeOfType(newState.doc, pos, "codeBlock"),
                  ),
              );
            }

            if (meta?.type === "toggle-heading") {
              foldedHeadings = foldedHeadings.includes(meta.pos)
                ? foldedHeadings.filter((pos) => pos !== meta.pos)
                : [...foldedHeadings, meta.pos];
            } else if (meta?.type === "toggle-code-block") {
              const node = newState.doc.nodeAt(meta.pos);
              if (node?.type.name === "codeBlock") {
                codeBlockOverrides = new Map(codeBlockOverrides).set(
                  meta.pos,
                  !isCodeBlockFolded(node, meta.pos, codeBlockOverrides),
                );
              }
            } else if (meta?.type === "reveal") {
              const unfold = new Set(
                headingsFoldingPos(newState.doc, foldedHeadings, meta.pos),
              );
              foldedHeadings = foldedHeadings.filter((pos) => !unfold.has(pos));
              const $pos = newState.doc.resolve(
                Math.min(meta.pos, newState.doc.content.size),
              );
              const blockPos = $pos.depth > 0 ? $pos.before(1) : meta.pos;
              const block = newState.doc.nodeAt(blockPos);
              if (block?.type.name === "codeBlock") {
                codeBlockOverrides = new Map(codeBlockOverrides).set(
                  blockPos,
                  false,
                );
              }
            }

            return {
              foldedHeadings,
              codeBlockOverrides,
              decorations: buildDecorations(
                newState.doc,
                foldedHeadings,
                codeBlockOverrides,
              ),
            };
          },
        },
        props: {
          decorations: (state) =>
            foldingPluginKey.getState(state)?.decorations ?? null,
        },
      }),
    ];
  },
});

/**
 * Unfolds whatever hides `element` (a folded section or a folded code block)
 * so navigation can scroll to it.
 */
export function revealFoldedContent(editor: Editor, element: Element) {
  let pos: number;
  try {
    if (!editor.view.dom.contains(element)) return;
    pos = editor.view.posAtDOM(element, 0);
  } catch {
    return;
  }

  editor.view.dispatch(
    editor.state.tr.setMeta(foldingPluginKey, {
      type: "reveal",
      pos,
    } satisfies FoldingMeta),
  );
}
