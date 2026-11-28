import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
// The shared diff lives in rfm; the app takes the dependency-free file directly.
import { diffTextBlocks } from "../../rfm/src/diff";

/**
 * Colors what changed since a baseline: a tint on changed words, a bar beside
 * added or changed blocks, a thin marker where something was removed.
 *
 * Decorations only. Nothing here edits the document, so it never marks it
 * dirty and never reaches the saved markdown.
 */

export type ChangeKind = "added" | "changed" | "removed";

export interface ChangeItem {
  kind: ChangeKind;
  /** Document position to scroll to. */
  pos: number;
}

interface ChangeHighlightState {
  /** Plain text of the baseline's text blocks; null when there is none. */
  baseline: string[] | null;
  visible: boolean;
  changes: ChangeItem[];
  /** The change the reader jumped to last, shown with a stronger color. */
  currentIndex: number | null;
  decorations: DecorationSet;
}

type ChangeHighlightMeta =
  | { type: "set-baseline"; texts: string[] | null }
  | { type: "set-visible"; visible: boolean }
  | { type: "recompute" }
  | { type: "focus"; index: number | null };

export const changeHighlightPluginKey = new PluginKey<ChangeHighlightState>(
  "roughdraftChangeHighlight",
);

/** How long after an edit the colors are recomputed. */
export const CHANGE_HIGHLIGHT_DEBOUNCE_MS = 300;

interface TextBlock {
  pos: number;
  node: ProseMirrorNode;
  text: string;
  isCode: boolean;
  /** Where each piece of `text` sits in the document. */
  segments: Array<{ start: number; length: number; pos: number }>;
}

/**
 * The text blocks of a document (paragraphs, headings, code blocks, table
 * cells), in order, with the text a reader sees. Blocks with no text are left
 * out. The same function reads the baseline and the live document, so their
 * blocks line up one to one.
 */
export function collectTextBlocks(doc: ProseMirrorNode): TextBlock[] {
  const blocks: TextBlock[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;

    let text = "";
    const segments: TextBlock["segments"] = [];
    node.descendants((child, childPos) => {
      if (child.isText) {
        const value = child.text ?? "";
        segments.push({
          start: text.length,
          length: value.length,
          pos: pos + 1 + childPos,
        });
        text += value;
      } else if (child.isLeaf) {
        text += " ";
      }
      return true;
    });

    if (text.trim()) {
      blocks.push({
        pos,
        node,
        text,
        isCode: node.type.name === "codeBlock",
        segments,
      });
    }
    return false;
  });
  return blocks;
}

/** The plain-text blocks of a document, for use as a baseline. */
export function baselineTextsFromDoc(doc: ProseMirrorNode): string[] {
  return collectTextBlocks(doc).map((block) => block.text);
}

function mapTextRange(
  block: TextBlock,
  start: number,
  end: number,
): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  for (const segment of block.segments) {
    const segmentEnd = segment.start + segment.length;
    const from = Math.max(start, segment.start);
    const to = Math.min(end, segmentEnd);
    if (to > from) {
      spans.push({
        from: segment.pos + (from - segment.start),
        to: segment.pos + (to - segment.start),
      });
    }
  }
  return spans;
}

function createRemovedMarker(oldText: string, count: number) {
  const marker = document.createElement("span");
  marker.className = "rd-change-removed";
  marker.contentEditable = "false";
  marker.dataset.testid = "change-removed-marker";
  const preview = oldText.length > 160 ? `${oldText.slice(0, 160)}…` : oldText;
  marker.title =
    count > 1 ? `${count} blocks removed here` : `Removed: ${preview}`;
  marker.setAttribute("aria-label", marker.title);
  return marker;
}

interface Computed {
  changes: ChangeItem[];
  build: (currentIndex: number | null) => DecorationSet;
}

function computeChanges(doc: ProseMirrorNode, baseline: string[]): Computed {
  const blocks = collectTextBlocks(doc);
  const diff = diffTextBlocks(
    baseline,
    blocks.map((block) => block.text),
  );

  interface Entry {
    pos: number;
    kind: ChangeKind;
    decorations: (current: boolean) => Decoration[];
  }
  const entries: Entry[] = [];

  diff.blocks.forEach((result, index) => {
    const block = blocks[index];
    if (!block || result.status === "same") return;
    const kind: ChangeKind = result.status;
    entries.push({
      pos: block.pos,
      kind,
      decorations: (current) => {
        const decorations: Decoration[] = [
          Decoration.node(block.pos, block.pos + block.node.nodeSize, {
            class: `rd-change-block rd-change-block--${kind}${
              current ? " rd-change-current" : ""
            }`,
            ...(current ? { "data-change-current": "true" } : {}),
            "data-testid": "change-block",
            "data-change-kind": kind,
          }),
        ];
        if (!block.isCode) {
          const ranges =
            kind === "added"
              ? [{ start: 0, end: block.text.length }]
              : result.ranges;
          for (const range of ranges) {
            for (const span of mapTextRange(block, range.start, range.end)) {
              decorations.push(
                Decoration.inline(span.from, span.to, {
                  class: `rd-change-word${
                    kind === "added" ? " rd-change-word--added" : ""
                  }`,
                  "data-testid": "change-word",
                }),
              );
            }
          }
        }
        return decorations;
      },
    });
  });

  // Consecutive removals in the same spot read as one.
  const removedByAnchor = new Map<number, string[]>();
  for (const removal of diff.removed) {
    const list = removedByAnchor.get(removal.beforeNewIndex) ?? [];
    list.push(baseline[removal.oldIndex] ?? "");
    removedByAnchor.set(removal.beforeNewIndex, list);
  }
  for (const [anchor, texts] of removedByAnchor) {
    const before = blocks[anchor];
    const last = blocks.at(-1);
    let pos: number;
    if (before) pos = before.pos + 1;
    else if (last) pos = last.pos + last.node.nodeSize - 1;
    else continue;
    entries.push({
      pos,
      kind: "removed",
      decorations: (current) => [
        Decoration.widget(
          pos,
          () => {
            const marker = createRemovedMarker(texts.join(" / "), texts.length);
            if (current) {
              marker.classList.add("rd-change-current");
              marker.dataset.changeCurrent = "true";
            }
            return marker;
          },
          {
            side: -1,
            ignoreSelection: true,
            key: `change-removed-${anchor}-${texts.length}-${current ? "c" : "n"}`,
          },
        ),
      ],
    });
  }

  entries.sort((a, b) => a.pos - b.pos);
  return {
    changes: entries.map(({ kind, pos }) => ({ kind, pos })),
    build: (currentIndex) =>
      DecorationSet.create(
        doc,
        entries.flatMap((entry, index) =>
          entry.decorations(index === currentIndex),
        ),
      ),
  };
}

function recompute(
  state: EditorState,
  previous: ChangeHighlightState,
  baseline: string[] | null,
  currentIndex: number | null,
): ChangeHighlightState {
  if (!baseline) {
    return {
      ...previous,
      baseline: null,
      changes: [],
      currentIndex: null,
      decorations: DecorationSet.empty,
    };
  }
  const computed = computeChanges(state.doc, baseline);
  const index =
    currentIndex !== null && currentIndex < computed.changes.length
      ? currentIndex
      : null;
  return {
    ...previous,
    baseline,
    changes: computed.changes,
    currentIndex: index,
    decorations: computed.build(index),
  };
}

export const ChangeHighlight = Extension.create({
  name: "changeHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<ChangeHighlightState>({
        key: changeHighlightPluginKey,
        state: {
          init: () => ({
            baseline: null,
            visible: true,
            changes: [],
            currentIndex: null,
            decorations: DecorationSet.empty,
          }),
          apply: (tr, value, _oldState, newState) => {
            const meta = tr.getMeta(changeHighlightPluginKey) as
              | ChangeHighlightMeta
              | undefined;
            if (meta?.type === "set-baseline") {
              return recompute(newState, value, meta.texts, null);
            }
            if (meta?.type === "recompute") {
              return recompute(
                newState,
                value,
                value.baseline,
                value.currentIndex,
              );
            }
            if (meta?.type === "set-visible") {
              return { ...value, visible: meta.visible };
            }
            if (meta?.type === "focus") {
              return recompute(newState, value, value.baseline, meta.index);
            }
            if (tr.docChanged && value.baseline) {
              // Until the debounced recompute, keep the colors on their text.
              return {
                ...value,
                changes: value.changes.map((change) => ({
                  ...change,
                  pos: tr.mapping.map(change.pos),
                })),
                decorations: value.decorations.map(tr.mapping, tr.doc),
              };
            }
            return value;
          },
        },
        props: {
          decorations: (state) => {
            const value = changeHighlightPluginKey.getState(state);
            return value?.visible ? value.decorations : DecorationSet.empty;
          },
        },
        view: () => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          return {
            update: (updatedView, previousState) => {
              if (updatedView.state.doc === previousState.doc) return;
              const value = changeHighlightPluginKey.getState(
                updatedView.state,
              );
              if (!value?.baseline) return;
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => {
                timer = null;
                if (updatedView.isDestroyed) return;
                updatedView.dispatch(
                  updatedView.state.tr.setMeta(changeHighlightPluginKey, {
                    type: "recompute",
                  } satisfies ChangeHighlightMeta),
                );
              }, CHANGE_HIGHLIGHT_DEBOUNCE_MS);
            },
            destroy: () => {
              if (timer) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});

function dispatchMeta(editor: Editor, meta: ChangeHighlightMeta) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(changeHighlightPluginKey, meta));
}

/** Sets (or, with null, clears) the text blocks of the baseline. */
export function setChangeBaseline(editor: Editor, texts: string[] | null) {
  dispatchMeta(editor, { type: "set-baseline", texts });
}

export function setChangesVisible(editor: Editor, visible: boolean) {
  dispatchMeta(editor, { type: "set-visible", visible });
}

export function getChangeHighlightState(editor: Editor) {
  if (editor.isDestroyed) return null;
  return changeHighlightPluginKey.getState(editor.state) ?? null;
}

/**
 * Jumps to the next (1) or previous (-1) change, wrapping around, scrolls it
 * into view and gives it the stronger color. Returns the new index.
 */
export function jumpToChange(editor: Editor, direction: 1 | -1): number | null {
  const state = getChangeHighlightState(editor);
  if (!state || state.changes.length === 0) return null;
  const count = state.changes.length;
  const index =
    state.currentIndex === null
      ? direction === 1
        ? 0
        : count - 1
      : (state.currentIndex + direction + count) % count;
  dispatchMeta(editor, { type: "focus", index });

  const target = getChangeHighlightState(editor)?.changes[index];
  if (target) {
    try {
      const at = editor.view.domAtPos(
        Math.min(target.pos + 1, editor.state.doc.content.size),
      );
      const element =
        at.node instanceof HTMLElement ? at.node : at.node.parentElement;
      element?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    } catch {
      // The position may be out of view's reach mid-update; the color stays.
    }
  }
  return index;
}
