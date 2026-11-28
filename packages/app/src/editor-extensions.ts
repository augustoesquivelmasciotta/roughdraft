import { Extension, Mark, mergeAttributes, Node } from "@tiptap/core";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import type {
  Mark as ProseMirrorMark,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { Transform } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import DOMPurify from "dompurify";
import { alertVariants } from "./components/ui/alert";
import { ChangeHighlight } from "./editor-change-highlight";
import { SectionFolding } from "./editor-folding";
import {
  decodeRawMarkdownBlock,
  type RawMarkdownBlockType,
  rawMarkdownBlockAttribute,
  rawMarkdownBlockTypeAttribute,
  toHtml,
} from "./markdown";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentRef: {
      setCommentRef: (attributes: { commentIds: string[] }) => ReturnType;
      removeCommentId: (commentId: string) => ReturnType;
      /**
       * Removes these comment ids from every highlight. Anchor text left with
       * no comment is deleted when one of the removed ids is in
       * `disposableCommentIds` (`anchor="disposable"`); otherwise it stays as
       * plain prose.
       */
      removeCommentIds: (
        commentIds: Iterable<string>,
        options?: { disposableCommentIds?: Iterable<string> },
      ) => ReturnType;
      unsetCommentRef: () => ReturnType;
    };
    criticChange: {
      setCriticChange: (attributes: CriticChangeAttrs) => ReturnType;
      unsetCriticChange: () => ReturnType;
      acceptCriticChange: (changeId: string) => ReturnType;
      rejectCriticChange: (changeId: string) => ReturnType;
      editCriticChange: (changeId: string, text: string) => ReturnType;
    };
  }
}

export type CriticChangeKind =
  | "addition"
  | "deletion"
  | "substitution-old"
  | "substitution-new";

export interface CriticChangeAttrs {
  kind: CriticChangeKind;
  changeId: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  createdAt: string;
}

/**
 * A reviewer's ruling on one suggestion mark. Accept collapses the mark to
 * its final text, reject restores the original text, and edit replaces the
 * whole mark with what the reviewer typed. All three leave plain prose.
 */
export type CriticChangeDecision =
  | { changeId: string; action: "accept" }
  | { changeId: string; action: "reject" }
  | { changeId: string; action: "edit"; text: string };

export const SUGGESTED_PARAGRAPH_SENTINEL = "\u2060";

const CommentRef = Mark.create({
  name: "commentRef",
  priority: 1100,
  inclusive: false,
  spanning: true,

  addAttributes() {
    return {
      commentIds: {
        default: [],
        parseHTML: (element) => {
          const ids = element.getAttribute("data-comment-ids");

          if (!ids) return [];

          try {
            return JSON.parse(ids);
          } catch {
            return [];
          }
        },
        renderHTML: (attributes) =>
          attributes.commentIds?.length
            ? { "data-comment-ids": JSON.stringify(attributes.commentIds) }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-ids]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "comment-anchor",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCommentRef:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes),
      removeCommentId:
        (commentId) =>
        ({ tr, state, dispatch }) => {
          const markType = state.schema.marks.commentRef;

          if (!markType) return false;

          let found = false;

          state.doc.descendants((node, pos) => {
            if (!node.isText) return;

            const mark = node.marks.find(
              (candidate) =>
                candidate.type === markType &&
                Array.isArray(candidate.attrs.commentIds) &&
                candidate.attrs.commentIds.includes(commentId),
            );

            if (!mark) return;

            found = true;

            const from = pos;
            const to = pos + node.nodeSize;
            const nextIds = (mark.attrs.commentIds as string[]).filter(
              (id) => id !== commentId,
            );

            tr.removeMark(from, to, markType);

            if (nextIds.length > 0) {
              tr.addMark(from, to, markType.create({ commentIds: nextIds }));
            }
          });

          if (found && dispatch) {
            dispatch(tr);
          }

          return found;
        },
      removeCommentIds:
        (commentIds, options) =>
        ({ tr, state, dispatch }) => {
          const markType = state.schema.marks.commentRef;
          if (!markType) return false;

          const removedIds = new Set(commentIds);
          if (removedIds.size === 0) return false;

          // The whole set leaving the document is known here, so an anchor
          // emptied by that set is judged once against every id it carried.
          // Deciding per comment would spare the anchor of a flagged thread
          // with replies, since the flagged root leaves while its replies
          // still hold the mark.
          const disposableIds = new Set(options?.disposableCommentIds ?? []);
          const disposedRanges: Array<{ from: number; to: number }> = [];
          let found = false;

          state.doc.descendants((node, pos) => {
            if (!node.isText) return;

            const mark = node.marks.find(
              (candidate) =>
                candidate.type === markType &&
                Array.isArray(candidate.attrs.commentIds) &&
                (candidate.attrs.commentIds as string[]).some((id) =>
                  removedIds.has(id),
                ),
            );
            if (!mark) return;

            found = true;
            const from = pos;
            const to = pos + node.nodeSize;
            const currentIds = mark.attrs.commentIds as string[];
            const nextIds = currentIds.filter((id) => !removedIds.has(id));

            tr.removeMark(from, to, markType);

            if (nextIds.length > 0) {
              tr.addMark(from, to, markType.create({ commentIds: nextIds }));
            } else if (currentIds.some((id) => disposableIds.has(id))) {
              disposedRanges.push({ from, to });
            }
          });

          // Marks do not move positions, deletions do: delete from the end.
          for (const range of [...disposedRanges].reverse()) {
            tr.delete(range.from, range.to);
          }

          if (found && dispatch) {
            dispatch(tr);
          }

          return found;
        },
      unsetCommentRef:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

function isCriticChangeKind(value: unknown): value is CriticChangeKind {
  return (
    value === "addition" ||
    value === "deletion" ||
    value === "substitution-old" ||
    value === "substitution-new"
  );
}

function readCriticChangeAttrs(element: HTMLElement): CriticChangeAttrs | null {
  const kind = element.getAttribute("data-critic-change-kind");
  const changeId = element.getAttribute("data-critic-change-id");
  const createdAt = element.getAttribute("data-critic-change-at");

  if (!isCriticChangeKind(kind) || !changeId || !createdAt) {
    return null;
  }

  const rawBy = element.getAttribute("data-critic-change-by") || "user";
  const authorType = rawBy.toUpperCase() === "AI" ? "ai" : "user";

  return {
    kind,
    changeId,
    authorType,
    authorId: authorType === "ai" ? null : rawBy,
    createdAt,
  };
}

function collectCriticChangeRanges(doc: ProseMirrorNode, changeId: string) {
  const markType = doc.type.schema.marks.criticChange;
  const ranges: Array<{
    from: number;
    to: number;
    kind: CriticChangeKind;
    mark: ProseMirrorMark;
  }> = [];

  if (!markType) return ranges;

  doc.descendants((node, pos) => {
    if (!node.isText) return;

    const mark = node.marks.find(
      (candidate) =>
        candidate.type === markType &&
        candidate.attrs.changeId === changeId &&
        isCriticChangeKind(candidate.attrs.kind),
    );

    if (!mark) return;

    const kind = mark.attrs.kind as CriticChangeKind;
    const previous = ranges[ranges.length - 1];

    if (
      previous &&
      previous.to === pos &&
      previous.kind === kind &&
      previous.mark.eq(mark)
    ) {
      previous.to = pos + node.nodeSize;
      return;
    }

    ranges.push({
      from: pos,
      to: pos + node.nodeSize,
      kind,
      mark,
    });
  });

  return ranges;
}

function findSuggestedParagraphSentinels(
  doc: ProseMirrorNode,
  from: number,
  to: number,
) {
  const positions: number[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return;

    let index = node.text.indexOf(SUGGESTED_PARAGRAPH_SENTINEL);
    while (index >= 0) {
      positions.push(pos + index);
      index = node.text.indexOf(SUGGESTED_PARAGRAPH_SENTINEL, index + 1);
    }
  });

  return positions;
}

function isOnlyTextblockContent(
  doc: ProseMirrorNode,
  from: number,
  to: number,
) {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);

  return (
    $from.sameParent($to) &&
    $from.parent.isTextblock &&
    from === $from.start() &&
    to === $from.end()
  );
}

function acceptCriticChangeInTransform(tr: Transform, changeId: string) {
  const markType = tr.doc.type.schema.marks.criticChange;
  if (!markType) return false;

  const ranges = collectCriticChangeRanges(tr.doc, changeId);
  if (ranges.length === 0) return false;

  for (const range of [...ranges].reverse()) {
    if (range.kind === "deletion" || range.kind === "substitution-old") {
      tr.delete(range.from, range.to);
    } else {
      const sentinelPositions = findSuggestedParagraphSentinels(
        tr.doc,
        range.from,
        range.to,
      );
      // Map through this range's own deletions only: in a chain the
      // transform already carries earlier commands' steps, and the range
      // was collected from the document those steps produced.
      const stepsBefore = tr.steps.length;

      for (const position of [...sentinelPositions].reverse()) {
        tr.delete(position, position + SUGGESTED_PARAGRAPH_SENTINEL.length);
      }

      const mapping = tr.mapping.slice(stepsBefore);
      tr.removeMark(
        mapping.map(range.from, -1),
        mapping.map(range.to, -1),
        markType,
      );
    }
  }

  return true;
}

function rejectCriticChangeInTransform(tr: Transform, changeId: string) {
  const markType = tr.doc.type.schema.marks.criticChange;
  if (!markType) return false;

  const ranges = collectCriticChangeRanges(tr.doc, changeId);
  if (ranges.length === 0) return false;

  for (const range of [...ranges].reverse()) {
    if (range.kind === "addition" || range.kind === "substitution-new") {
      const sentinelPositions = findSuggestedParagraphSentinels(
        tr.doc,
        range.from,
        range.to,
      );
      if (
        sentinelPositions.length > 0 &&
        isOnlyTextblockContent(tr.doc, range.from, range.to)
      ) {
        const $from = tr.doc.resolve(range.from);
        tr.delete($from.before(), $from.after());
      } else {
        tr.delete(range.from, range.to);
      }
    } else {
      tr.removeMark(range.from, range.to, markType);
    }
  }

  return true;
}

function editCriticChangeInTransform(
  tr: Transform,
  changeId: string,
  text: string,
) {
  const schema = tr.doc.type.schema;
  if (!schema.marks.criticChange) return false;

  const ranges = collectCriticChangeRanges(tr.doc, changeId);
  if (ranges.length === 0) return false;

  // The rail editor trims what the reviewer types, so the mark's own edge
  // whitespace is what keeps the edited words spaced from the prose.
  const finalText = ranges
    .filter(
      (range) => range.kind === "addition" || range.kind === "substitution-new",
    )
    .map((range) => tr.doc.textBetween(range.from, range.to, "", " "))
    .join("");
  const leadingWhitespace =
    finalText.trim().length === 0
      ? finalText
      : (finalText.match(/^\s*/)?.[0] ?? "");
  const trailingWhitespace =
    finalText.trim().length === 0 ? "" : (finalText.match(/\s*$/)?.[0] ?? "");
  const replacement = `${/^\s/.test(text) ? "" : leadingWhitespace}${text}${
    /\s$/.test(text) ? "" : trailingWhitespace
  }`;

  for (const range of [...ranges].reverse()) {
    tr.delete(range.from, range.to);
  }

  if (replacement.length === 0) return true;

  // Every later range was deleted first, so the first range still starts
  // where it did.
  const insertAt = ranges[0].from;
  const proseMarks = tr.doc
    .resolve(insertAt)
    .marks()
    .filter(
      (mark) =>
        mark.type.name !== "criticChange" && mark.type.name !== "commentRef",
    );
  tr.insert(insertAt, schema.text(replacement, proseMarks));

  return true;
}

/**
 * Applies one reviewer decision to a suggestion mark on a transform that
 * need not belong to a mounted editor. Returns false when the document has
 * no mark with that id, leaving the transform untouched.
 */
export function applyCriticChangeDecision(
  tr: Transform,
  decision: CriticChangeDecision,
) {
  switch (decision.action) {
    case "accept":
      return acceptCriticChangeInTransform(tr, decision.changeId);
    case "reject":
      return rejectCriticChangeInTransform(tr, decision.changeId);
    case "edit":
      return editCriticChangeInTransform(tr, decision.changeId, decision.text);
  }
}

const CriticChange = Mark.create({
  name: "criticChange",
  priority: 1090,
  inclusive: false,
  spanning: true,

  addAttributes() {
    return {
      kind: {
        default: "addition",
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.kind ?? "addition",
        renderHTML: (attributes) => ({
          "data-critic-change-kind": attributes.kind,
        }),
      },
      changeId: {
        default: null,
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.changeId ?? null,
        renderHTML: (attributes) =>
          attributes.changeId
            ? { "data-critic-change-id": attributes.changeId }
            : {},
      },
      authorType: {
        default: "user",
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.authorType ?? "user",
        renderHTML: () => ({}),
      },
      authorId: {
        default: "user",
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.authorId ?? "user",
        renderHTML: (attributes) => ({
          "data-critic-change-by":
            attributes.authorType === "ai"
              ? "AI"
              : attributes.authorId || "user",
        }),
      },
      createdAt: {
        default: null,
        parseHTML: (element) =>
          readCriticChangeAttrs(element as HTMLElement)?.createdAt ?? null,
        renderHTML: (attributes) =>
          attributes.createdAt
            ? { "data-critic-change-at": attributes.createdAt }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-critic-change-kind]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: `critic-change critic-change-${HTMLAttributes["data-critic-change-kind"]}`,
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCriticChange:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes),
      unsetCriticChange:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
      acceptCriticChange:
        (changeId) =>
        ({ state, dispatch }) => {
          const tr = state.tr;
          if (!acceptCriticChangeInTransform(tr, changeId)) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
      rejectCriticChange:
        (changeId) =>
        ({ state, dispatch }) => {
          const tr = state.tr;
          if (!rejectCriticChangeInTransform(tr, changeId)) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
      editCriticChange:
        (changeId, text) =>
        ({ state, dispatch }) => {
          const tr = state.tr;
          if (!editCriticChangeInTransform(tr, changeId, text)) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

interface CommentHighlightMeta {
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
}

interface CommentHighlightPluginState extends CommentHighlightMeta {
  decorations: DecorationSet;
}

interface CriticChangeHighlightMeta {
  selectedChangeId: string | null;
  hoveredChangeId: string | null;
}

interface CriticChangeHighlightPluginState extends CriticChangeHighlightMeta {
  decorations: DecorationSet;
}

export const commentHighlightPluginKey =
  new PluginKey<CommentHighlightPluginState>("commentHighlight");
export const criticChangeHighlightPluginKey =
  new PluginKey<CriticChangeHighlightPluginState>("criticChangeHighlight");

function createCommentHighlightDecorations(
  doc: ProseMirrorNode,
  selectedCommentId: string | null,
  hoveredCommentId: string | null,
) {
  const commentMarkType = doc.type.schema.marks.commentRef;
  const changeMarkType = doc.type.schema.marks.criticChange;
  const decorations: Decoration[] = [];

  if (!commentMarkType) {
    return DecorationSet.create(doc, decorations);
  }

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!node.isText) return;

    const commentIds = [
      ...new Set(
        node.marks.flatMap((mark: ProseMirrorMark) =>
          mark.type === commentMarkType && Array.isArray(mark.attrs.commentIds)
            ? mark.attrs.commentIds
            : [],
        ),
      ),
    ];

    if (commentIds.length === 0) return;

    const isSelected =
      !!selectedCommentId && commentIds.includes(selectedCommentId);
    const isHovered =
      !!hoveredCommentId && commentIds.includes(hoveredCommentId);
    const classNames = ["comment-decoration"];

    if (isSelected) {
      classNames.push("comment-decoration-active");
    } else if (isHovered) {
      classNames.push("comment-decoration-hovered");
    }

    if (
      changeMarkType &&
      node.marks.some((mark) => mark.type === changeMarkType)
    ) {
      classNames.push("comment-decoration-on-critic-change");
    }

    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: classNames.join(" "),
        "data-testid": classNames.includes(
          "comment-decoration-on-critic-change",
        )
          ? "comment-decoration-on-critic-change"
          : "comment-decoration",
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

const CommentHighlight = Extension.create({
  name: "commentHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<CommentHighlightPluginState>({
        key: commentHighlightPluginKey,
        state: {
          init: (_, state) => ({
            selectedCommentId: null,
            hoveredCommentId: null,
            decorations: createCommentHighlightDecorations(
              state.doc,
              null,
              null,
            ),
          }),
          apply: (tr, pluginState) => {
            const meta = tr.getMeta(commentHighlightPluginKey) as
              | CommentHighlightMeta
              | undefined;

            if (!meta && !tr.docChanged) {
              return pluginState;
            }

            const selectedCommentId =
              meta !== undefined
                ? meta.selectedCommentId
                : pluginState.selectedCommentId;
            const hoveredCommentId =
              meta !== undefined
                ? meta.hoveredCommentId
                : pluginState.hoveredCommentId;

            return {
              selectedCommentId,
              hoveredCommentId,
              decorations: createCommentHighlightDecorations(
                tr.doc,
                selectedCommentId,
                hoveredCommentId,
              ),
            };
          },
        },
        props: {
          decorations: (state) =>
            commentHighlightPluginKey.getState(state)?.decorations ?? null,
        },
      }),
    ];
  },
});

function createCriticChangeHighlightDecorations(
  doc: ProseMirrorNode,
  selectedChangeId: string | null,
  hoveredChangeId: string | null,
) {
  const changeMarkType = doc.type.schema.marks.criticChange;
  const decorations: Decoration[] = [];

  if (!changeMarkType) {
    return DecorationSet.create(doc, decorations);
  }

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!node.isText) return;

    const changeIds = [
      ...new Set(
        node.marks.flatMap((mark: ProseMirrorMark) =>
          mark.type === changeMarkType &&
          typeof mark.attrs.changeId === "string"
            ? [mark.attrs.changeId]
            : [],
        ),
      ),
    ];

    if (changeIds.length === 0) return;

    const isSelected =
      !!selectedChangeId && changeIds.includes(selectedChangeId);
    const isHovered = !!hoveredChangeId && changeIds.includes(hoveredChangeId);

    if (!isSelected && !isHovered) return;

    const changeKind = node.marks.find(
      (mark) =>
        mark.type === changeMarkType &&
        typeof mark.attrs.changeId === "string" &&
        changeIds.includes(mark.attrs.changeId) &&
        isCriticChangeKind(mark.attrs.kind),
    )?.attrs.kind as CriticChangeKind | undefined;
    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        "data-testid": isSelected
          ? "critic-change-decoration-active"
          : "critic-change-decoration-hovered",
        class: [
          isSelected
            ? "critic-change-decoration-active"
            : "critic-change-decoration-hovered",
          changeKind ? `critic-change-decoration-${changeKind}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      }),
    );
  });

  return DecorationSet.create(doc, decorations);
}

const CriticChangeHighlight = Extension.create({
  name: "criticChangeHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<CriticChangeHighlightPluginState>({
        key: criticChangeHighlightPluginKey,
        state: {
          init: (_, state) => ({
            selectedChangeId: null,
            hoveredChangeId: null,
            decorations: createCriticChangeHighlightDecorations(
              state.doc,
              null,
              null,
            ),
          }),
          apply: (tr, pluginState) => {
            const meta = tr.getMeta(criticChangeHighlightPluginKey) as
              | CriticChangeHighlightMeta
              | undefined;

            if (!meta && !tr.docChanged) {
              return pluginState;
            }

            const selectedChangeId =
              meta !== undefined
                ? meta.selectedChangeId
                : pluginState.selectedChangeId;
            const hoveredChangeId =
              meta !== undefined
                ? meta.hoveredChangeId
                : pluginState.hoveredChangeId;

            return {
              selectedChangeId,
              hoveredChangeId,
              decorations: createCriticChangeHighlightDecorations(
                tr.doc,
                selectedChangeId,
                hoveredChangeId,
              ),
            };
          },
        },
        props: {
          decorations: (state) =>
            criticChangeHighlightPluginKey.getState(state)?.decorations ?? null,
        },
      }),
    ];
  },
});

const MarkdownLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute("title"),
        renderHTML: (attributes) =>
          attributes.title ? { title: attributes.title } : {},
      },
      dataMarkdownSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-src"),
        renderHTML: (attributes) =>
          attributes.dataMarkdownSrc
            ? { "data-markdown-src": attributes.dataMarkdownSrc }
            : {},
      },
      dataMarkdownAutolink: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-autolink"),
        renderHTML: (attributes) =>
          attributes.dataMarkdownAutolink
            ? { "data-markdown-autolink": attributes.dataMarkdownAutolink }
            : {},
      },
    };
  },
});

const MarkdownCode = Code.extend({
  excludes: "bold italic strike link",
});

const MarkdownCodeBlock = CodeBlock.extend({
  marks: "commentRef criticChange",

  addAttributes() {
    return {
      ...this.parent?.(),
      // The original fence (for example ```` or ~~~) and full info string, so
      // an edited block is written back the way it was opened.
      fence: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-fence"),
        renderHTML: (attributes) =>
          attributes.fence ? { "data-fence": attributes.fence } : {},
      },
      info: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-info"),
        renderHTML: (attributes) =>
          attributes.info ? { "data-info": attributes.info } : {},
      },
    };
  },
});

const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute("title"),
        renderHTML: (attributes) =>
          attributes.title ? { title: attributes.title } : {},
      },
      dataMarkdownSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-markdown-src"),
        renderHTML: (attributes) =>
          attributes.dataMarkdownSrc
            ? { "data-markdown-src": attributes.dataMarkdownSrc }
            : {},
      },
    };
  },
});

/**
 * Shows a raw markdown block (a `<details>` section, an indented code block
 * after a list, a table with escaped pipes) as a sanitized, read-only
 * preview. `<details>` blocks become real collapsible sections. HTML
 * comments are source-only notes and stay hidden.
 */
const rawBlockLabels: Record<RawMarkdownBlockType, string> = {
  table: "Table",
  details: "Details block",
  "html-comment": "HTML comment",
  "indented-code": "Indented code block",
};

function rawBlockLabel(blockType: string): string {
  return blockType in rawBlockLabels
    ? rawBlockLabels[blockType as RawMarkdownBlockType]
    : "Block";
}

// Something a reader can see even without text: an image, a rule, a table...
const visibleWithoutTextSelector =
  "img, svg, hr, table, details, summary, pre, code, input, video, iframe";

/**
 * A visible box where a block could not be shown, naming its type, so the
 * reader never meets an unexplained gap. The markdown is kept untouched.
 */
function renderUnrenderedBlockPlaceholder(dom: HTMLElement, blockType: string) {
  const label = rawBlockLabel(blockType);
  dom.className = "rd-raw-block rd-raw-block--unrendered my-4";
  dom.dataset.unrenderedBlock = "true";

  const alert = document.createElement("div");
  alert.dataset.slot = "alert";
  alert.dataset.testid = "unrendered-block-placeholder";
  alert.dataset.blockType = blockType;
  alert.setAttribute("role", "note");
  alert.className = alertVariants({ variant: "default" });

  const title = document.createElement("div");
  title.dataset.slot = "alert-title";
  title.className = "font-medium";
  title.textContent = `${label} not rendered`;

  const description = document.createElement("div");
  description.dataset.slot = "alert-description";
  description.className = "text-xs/relaxed text-muted-foreground";
  description.textContent = `Roughdraft could not show this ${label.toLowerCase()} in rich text. Its Markdown is kept exactly as written; switch to code view to read or edit it.`;

  alert.append(title, description);
  dom.replaceChildren(alert);
}

function renderRawMarkdownPreview(
  dom: HTMLElement,
  encoded: string,
  blockType: string,
) {
  const markdown = decodeRawMarkdownBlock(encoded);
  dom.setAttribute(rawMarkdownBlockAttribute, encoded);
  dom.setAttribute(rawMarkdownBlockTypeAttribute, blockType);
  delete dom.dataset.unrenderedBlock;

  if (/^\s*<!--[\s\S]*-->\s*$/.test(markdown)) {
    dom.className = "rd-raw-block rd-raw-block--hidden";
    dom.replaceChildren();
    return;
  }

  let html: string;
  try {
    html = DOMPurify.sanitize(toHtml(markdown));
  } catch (error) {
    console.error("Failed to render a raw markdown block:", error);
    renderUnrenderedBlockPlaceholder(dom, blockType);
    return;
  }

  dom.className = "rd-raw-block";
  dom.innerHTML = html;
  if (
    !dom.textContent?.trim() &&
    !dom.querySelector(visibleWithoutTextSelector)
  ) {
    renderUnrenderedBlockPlaceholder(dom, blockType);
    return;
  }
  for (const link of dom.querySelectorAll("a[href]")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
  }
}

/**
 * Spec key the guard puts on a node decoration when it has just refused a
 * change that would have deleted this block.
 */
const rawMarkdownBlockDeletionRefusedDecoration =
  "rawMarkdownBlockDeletionRefused";

function hasDeletionRefusedDecoration(
  decorations: readonly Decoration[],
): boolean {
  return decorations.some(
    (decoration) =>
      (decoration.spec as Record<string, unknown> | undefined)?.[
        rawMarkdownBlockDeletionRefusedDecoration
      ] === true,
  );
}

/**
 * Tells the reader why their keystroke did nothing. It says only what stays
 * true once the refusal has run: the caret is already clear of the block, so
 * the next character lands.
 */
function renderDeletionRefusedNote(dom: HTMLElement, blockType: string) {
  const label = rawBlockLabel(blockType).toLowerCase();
  // A hidden HTML comment has no box of its own; show the note anyway.
  dom.classList.remove("rd-raw-block--hidden");
  const note = document.createElement("div");
  note.dataset.slot = "alert";
  note.dataset.testid = "unrendered-block-deletion-refused";
  note.setAttribute("role", "status");
  note.className = `${alertVariants({ variant: "default" })} mt-2`;
  note.textContent = `Rich text will not delete this ${label}, and will not delete a selection that includes it. Switch to code view to remove its Markdown.`;
  dom.append(note);
}

const RawMarkdownBlock = Node.create({
  name: "rawMarkdownBlock",
  group: "block",
  atom: true,
  selectable: true,

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.contentEditable = "false";
      dom.dataset.testid = "raw-markdown-block";
      let currentMarkdown = String(node.attrs.rawMarkdown ?? "");
      let currentType = String(node.attrs.blockType ?? "block");
      let currentRefused = false;
      renderRawMarkdownPreview(dom, currentMarkdown, currentType);

      return {
        dom,
        update: (updatedNode, decorations) => {
          if (updatedNode.type.name !== "rawMarkdownBlock") return false;
          const nextMarkdown = String(updatedNode.attrs.rawMarkdown ?? "");
          const nextType = String(updatedNode.attrs.blockType ?? "block");
          const nextRefused = hasDeletionRefusedDecoration(decorations);
          if (
            nextMarkdown !== currentMarkdown ||
            nextType !== currentType ||
            nextRefused !== currentRefused
          ) {
            currentMarkdown = nextMarkdown;
            currentType = nextType;
            currentRefused = nextRefused;
            renderRawMarkdownPreview(dom, nextMarkdown, nextType);
            if (nextRefused) renderDeletionRefusedNote(dom, nextType);
          }
          return true;
        },
        // Says whether the block is the editor's selection, which nothing
        // else on this element shows (and a keystroke then acts on it).
        selectNode: () => {
          dom.dataset.selected = "true";
          dom.classList.add("ProseMirror-selectednode");
        },
        deselectNode: () => {
          delete dom.dataset.selected;
          dom.classList.remove("ProseMirror-selectednode");
        },
        // The preview is read-only: let the reader open <details> and follow
        // links without the editor treating it as an edit.
        stopEvent: () => true,
        ignoreMutation: () => true,
      };
    };
  },

  addAttributes() {
    return {
      rawMarkdown: {
        default: "",
        parseHTML: (element) =>
          element.getAttribute(rawMarkdownBlockAttribute) ?? "",
        renderHTML: (attributes) => ({
          [rawMarkdownBlockAttribute]: attributes.rawMarkdown ?? "",
        }),
      },
      blockType: {
        default: "block",
        parseHTML: (element) =>
          element.getAttribute(rawMarkdownBlockTypeAttribute) ?? "block",
        renderHTML: (attributes) => ({
          [rawMarkdownBlockTypeAttribute]: attributes.blockType ?? "block",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${rawMarkdownBlockAttribute}]`, priority: 1000 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)];
  },
});

/** Position of the raw block whose deletion was just refused, if any. */
interface RawMarkdownBlockGuardState {
  refusedPos: number | null;
}

export const rawMarkdownBlockGuardPluginKey =
  new PluginKey<RawMarkdownBlockGuardState>("rawMarkdownBlockGuard");

/**
 * Position of the first raw block this transaction would drop, or null when
 * it would drop none. Textblocks are not descended into, so the walk stays
 * cheap enough to run on every transaction.
 *
 * Each block is judged on its own extent: both ends are mapped inward, so a
 * deletion beside the block leaves them a whole node apart while a deletion
 * of the block collapses them. The survivor must also carry the same
 * Markdown, so swapping a different raw block in where one stood counts as a
 * loss while replacing a block by an identical copy does not.
 */
function firstDroppedRawBlockPos(
  tr: Transaction,
  doc: ProseMirrorNode,
): number | null {
  let dropped: number | null = null;

  doc.descendants((node, pos) => {
    if (dropped !== null) return false;
    if (node.type.name !== "rawMarkdownBlock") return !node.isTextblock;

    const start = tr.mapping.map(pos, 1);
    const end = tr.mapping.map(pos + node.nodeSize, -1);
    const survivor = tr.doc.nodeAt(start);

    if (
      end - start !== node.nodeSize ||
      survivor?.type.name !== "rawMarkdownBlock" ||
      survivor.attrs.rawMarkdown !== node.attrs.rawMarkdown
    ) {
      dropped = pos;
    }

    return false;
  });

  return dropped;
}

/**
 * Marks the refusal on the block and moves the caret clear of it. Without
 * the move, the selection that spanned the block stays, and every character
 * typed next would be another refused replacement of that range.
 */
function releaseSelection(view: EditorView, refusedPos: number): void {
  if (view.isDestroyed) return;
  const tr = view.state.tr.setMeta(rawMarkdownBlockGuardPluginKey, {
    refusedPos,
  });
  const node = view.state.doc.nodeAt(refusedPos);
  if (node) {
    tr.setSelection(
      TextSelection.near(view.state.doc.resolve(refusedPos + node.nodeSize), 1),
    );
  }
  view.dispatch(tr);
}

/**
 * Keeps a raw block (a <details> section, an escaped-pipe table, indented
 * code after a list, an HTML comment) from leaving the document through rich
 * text. Rich text cannot recreate these blocks, so Backspace or Delete on a
 * selected block, typing, cutting or pasting over a selection that includes
 * one, or Backspace at the start of the paragraph after one would drop its
 * Markdown, and autosave would write the loss to disk.
 *
 * The rule is about the document, not about a gesture: any transaction that
 * would drop a raw block is rejected, whatever produced it. Two exemptions
 * cover the legitimate ways a block leaves: tiptap's `setContent` (a document
 * loaded or reloaded from disk, Descartar cambios included), marked by the
 * `preventUpdate` meta, and undo/redo, marked by the history meta. The code
 * view edits the Markdown directly and never meets this rule.
 *
 * Suggesting mode never trips it (its handlers turn edits into suggestion
 * marks), and Viewing mode dispatches no edits.
 */
const RawMarkdownBlockGuard = Extension.create({
  name: "rawMarkdownBlockGuard",

  addProseMirrorPlugins() {
    const { editor } = this;

    return [
      new Plugin<RawMarkdownBlockGuardState>({
        key: rawMarkdownBlockGuardPluginKey,
        state: {
          init: () => ({ refusedPos: null }),
          apply(tr, value) {
            const meta = tr.getMeta(rawMarkdownBlockGuardPluginKey) as
              | RawMarkdownBlockGuardState
              | undefined;
            if (meta) return meta;
            if (value.refusedPos === null) return value;
            return tr.docChanged || tr.selectionSet
              ? { refusedPos: null }
              : value;
          },
        },
        filterTransaction(tr, state) {
          if (!tr.docChanged) return true;
          // `PluginKey("history")` resolves to this name; reading it keeps
          // the guard from importing the history plugin.
          if (tr.getMeta("history$")) return true;
          if (tr.getMeta("preventUpdate") !== undefined) return true;

          const refusedPos = firstDroppedRawBlockPos(tr, state.doc);
          if (refusedPos === null) return true;

          // The transaction is rejected, so the position still points at the
          // block. Marking it and moving the caret wait for this dispatch to
          // finish.
          queueMicrotask(() => {
            releaseSelection(editor.view, refusedPos);
          });
          return false;
        },
        props: {
          decorations(state) {
            const refusedPos =
              rawMarkdownBlockGuardPluginKey.getState(state)?.refusedPos ??
              null;
            if (refusedPos === null) return null;
            const node = state.doc.nodeAt(refusedPos);
            if (!node) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(
                refusedPos,
                refusedPos + node.nodeSize,
                {},
                { [rawMarkdownBlockDeletionRefusedDecoration]: true },
              ),
            ]);
          },
        },
      }),
    ];
  },
});

export function createEditorExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3, 4, 5, 6],
      },
      code: false,
      codeBlock: false,
      link: false,
    }),
    Placeholder.configure({
      placeholder,
    }),
    MarkdownLink.configure({
      autolink: true,
      openOnClick: false,
      linkOnPaste: true,
    }),
    MarkdownCode,
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    CommentRef,
    CriticChange,
    RawMarkdownBlock,
    RawMarkdownBlockGuard,
    MarkdownCodeBlock,
    CommentHighlight,
    CriticChangeHighlight,
    SectionFolding,
    ChangeHighlight,
    MarkdownImage.configure({
      allowBase64: true,
      inline: false,
    }),
  ];
}
