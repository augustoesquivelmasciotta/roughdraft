import type { JSONContent } from "@tiptap/core";

/**
 * Block-level source preservation for rich-text saves.
 *
 * When a document is opened, each top-level markdown block is remembered
 * together with the editor nodes it produced and the exact text between
 * blocks. When the document is saved, blocks whose nodes are unchanged are
 * written back from that original text, so untouched content round-trips
 * byte for byte (ADR 0003). Only edited, inserted or repaired blocks go
 * through the HTML-to-markdown serializer, and they reuse the original
 * spacing around them.
 */

export interface SourceBlock {
  /** Original markdown of the block, without its trailing line breaks. */
  source: string;
  nodeStart: number;
  nodeEnd: number;
  firstType: string;
  lastType: string;
}

export interface MarkdownSourceSnapshot {
  /**
   * `slots[k]` is the original text before block `k`: `slots[0]` is the text
   * before the first block, `slots[blocks.length]` the text after the last.
   * Slots are usually whitespace, but can hold source-only content such as
   * link reference definitions.
   */
  slots: string[];
  blocks: SourceBlock[];
  /** Match keys of the original top-level nodes. */
  nodeKeys: string[];
  nodes: JSONContent[];
  /** Original node indexes that must be re-serialized (repairs, migrations). */
  forcedNodes: number[];
}

export interface SnapshotTokenInput {
  raw: string;
  nodes: JSONContent[];
}

export function buildSourceSnapshot(options: {
  /** Markdown that was lexed (after round-trip protections). */
  lexedBody: string;
  /** Markdown as it is on disk. */
  originalBody: string;
  tokens: SnapshotTokenInput[];
  decode: (markdown: string) => string;
  nodeKey: (node: JSONContent) => string;
  forcedNodes?: (node: JSONContent) => boolean;
}): MarkdownSourceSnapshot | null {
  const { lexedBody, tokens, decode } = options;
  const slots: string[] = [];
  const blocks: SourceBlock[] = [];
  const nodes: JSONContent[] = [];
  let pending = "";
  let cursor = 0;

  for (const token of tokens) {
    if (!token.raw) continue;

    const at = lexedBody.indexOf(token.raw, cursor);
    if (at === -1) return null;

    pending += lexedBody.slice(cursor, at);
    cursor = at + token.raw.length;

    if (token.nodes.length === 0) {
      pending += token.raw;
      continue;
    }

    const trailing = token.raw.match(/\n\s*$/);
    const content = trailing ? token.raw.slice(0, trailing.index) : token.raw;

    slots.push(pending);
    pending = trailing?.[0] ?? "";
    blocks.push({
      source: content,
      nodeStart: nodes.length,
      nodeEnd: nodes.length + token.nodes.length,
      firstType: token.nodes[0]?.type ?? "paragraph",
      lastType: token.nodes.at(-1)?.type ?? "paragraph",
    });
    nodes.push(...token.nodes);
  }

  pending += lexedBody.slice(cursor);
  slots.push(pending);

  const decodedSlots = slots.map(decode);
  const decodedBlocks = blocks.map((block) => ({
    ...block,
    source: decode(block.source),
  }));

  let rebuilt = decodedSlots[0] ?? "";
  decodedBlocks.forEach((block, index) => {
    rebuilt += block.source + (decodedSlots[index + 1] ?? "");
  });
  if (rebuilt !== options.originalBody) return null;

  const forcedNodes: number[] = [];
  nodes.forEach((node, index) => {
    if (options.forcedNodes?.(node)) forcedNodes.push(index);
  });

  return {
    slots: decodedSlots,
    blocks: decodedBlocks,
    nodeKeys: nodes.map(options.nodeKey),
    // A private copy: the editor document must never alias the originals.
    nodes: structuredClone(nodes),
    forcedNodes,
  };
}

const MAX_LCS_CELLS = 4_000_000;

function alignNodeKeys(
  originalKeys: string[],
  currentKeys: string[],
): { originalToCurrent: number[]; currentToOriginal: number[] } {
  const originalToCurrent = new Array<number>(originalKeys.length).fill(-1);
  const currentToOriginal = new Array<number>(currentKeys.length).fill(-1);
  const link = (original: number, current: number) => {
    originalToCurrent[original] = current;
    currentToOriginal[current] = original;
  };

  let prefix = 0;
  while (
    prefix < originalKeys.length &&
    prefix < currentKeys.length &&
    originalKeys[prefix] === currentKeys[prefix]
  ) {
    link(prefix, prefix);
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalKeys.length - prefix &&
    suffix < currentKeys.length - prefix &&
    originalKeys[originalKeys.length - 1 - suffix] ===
      currentKeys[currentKeys.length - 1 - suffix]
  ) {
    link(originalKeys.length - 1 - suffix, currentKeys.length - 1 - suffix);
    suffix += 1;
  }

  const originalMiddle = originalKeys.slice(
    prefix,
    originalKeys.length - suffix,
  );
  const currentMiddle = currentKeys.slice(prefix, currentKeys.length - suffix);
  const rows = originalMiddle.length;
  const columns = currentMiddle.length;

  if (rows === 0 || columns === 0 || rows * columns > MAX_LCS_CELLS) {
    return { originalToCurrent, currentToOriginal };
  }

  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        originalMiddle[row] === currentMiddle[column]
          ? (table[(row + 1) * width + column + 1] ?? 0) + 1
          : Math.max(
              table[(row + 1) * width + column] ?? 0,
              table[row * width + column + 1] ?? 0,
            );
    }
  }

  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (originalMiddle[row] === currentMiddle[column]) {
      link(prefix + row, prefix + column);
      row += 1;
      column += 1;
    } else if (
      (table[(row + 1) * width + column] ?? 0) >=
      (table[row * width + column + 1] ?? 0)
    ) {
      row += 1;
    } else {
      column += 1;
    }
  }

  return { originalToCurrent, currentToOriginal };
}

/**
 * Second chance for nodes whose match keys differ (for example because a
 * reply was attached in the endmatter, which changes the node's comment ids
 * but not its markdown): pair unmatched nodes inside the same gap when they
 * serialize to the same markdown.
 */
function matchGapsByContent(
  alignment: { originalToCurrent: number[]; currentToOriginal: number[] },
  forced: Set<number>,
  sameContent: (originalIndex: number, currentIndex: number) => boolean,
) {
  const { originalToCurrent, currentToOriginal } = alignment;
  let originalCursor = 0;
  let current = 0;

  while (current < currentToOriginal.length) {
    const matchedOriginal = currentToOriginal[current] ?? -1;
    if (matchedOriginal !== -1) {
      originalCursor = matchedOriginal + 1;
      current += 1;
      continue;
    }

    let gapEnd = originalCursor;
    while (
      gapEnd < originalToCurrent.length &&
      (originalToCurrent[gapEnd] ?? -1) === -1
    ) {
      gapEnd += 1;
    }

    for (let original = originalCursor; original < gapEnd; original += 1) {
      if (forced.has(original)) continue;
      if ((originalToCurrent[original] ?? -1) !== -1) continue;
      if (!sameContent(original, current)) continue;

      originalToCurrent[original] = current;
      currentToOriginal[current] = original;
      originalCursor = original + 1;
      break;
    }

    current += 1;
  }
}

type Piece =
  | { kind: "block"; block: number }
  | {
      kind: "run";
      nodes: number[];
      /** Slot before the run and slot after it, in original numbering. */
      slotBefore: number;
      slotAfter: number;
    };

const selfDelimitingTypes = new Set(["heading", "codeBlock", "horizontalRule"]);

/**
 * Block contents never end with a line break (it belongs to the separator),
 * so a separator holds a blank line only when it has two line breaks.
 */
function hasBlankLine(text: string): boolean {
  return /\n[ \t]*\n/.test(text);
}

function joinSeparator(
  separator: string,
  previousType: string | null,
  nextType: string | null,
): string {
  if (previousType === null || nextType === null) return separator;
  if (hasBlankLine(separator)) return separator;
  if (
    selfDelimitingTypes.has(previousType) ||
    selfDelimitingTypes.has(nextType)
  ) {
    return separator.includes("\n") ? separator : `${separator}\n`;
  }

  return `${separator.replace(/\s*$/, "")}\n\n`;
}

function contentOfSlot(slot: string): string {
  return slot.trim() ? slot.replace(/^\s+/, "") : "";
}

export function serializeWithSourceSnapshot(options: {
  snapshot: MarkdownSourceSnapshot;
  nodes: JSONContent[];
  nodeKey: (node: JSONContent) => string;
  sameContent: (originalIndex: number, node: JSONContent) => boolean;
  serializeNode: (node: JSONContent) => string;
  onUntouchedNode?: (node: JSONContent) => void;
}): string {
  const { snapshot, nodes } = options;
  const forced = new Set(snapshot.forcedNodes);
  const originalKeys = snapshot.nodeKeys.map((key, index) =>
    forced.has(index) ? `\u0000forced:${index}` : key,
  );
  const currentKeys = nodes.map(options.nodeKey);
  const alignment = alignNodeKeys(originalKeys, currentKeys);
  matchGapsByContent(alignment, forced, (original, current) => {
    const node = nodes[current];
    return node ? options.sameContent(original, node) : false;
  });

  const untouchedBlockAtCurrent = new Map<number, number>();
  snapshot.blocks.forEach((block, blockIndex) => {
    const first = alignment.originalToCurrent[block.nodeStart] ?? -1;
    if (first === -1) return;

    for (
      let offset = 0;
      offset < block.nodeEnd - block.nodeStart;
      offset += 1
    ) {
      if (
        alignment.originalToCurrent[block.nodeStart + offset] !==
        first + offset
      ) {
        return;
      }
    }

    untouchedBlockAtCurrent.set(first, blockIndex);
  });

  const pieces: Piece[] = [];
  let lastBlock = -1;
  let run: number[] = [];
  const flushRun = (nextBlock: number) => {
    if (run.length === 0) return;
    const replacesOriginal = nextBlock - lastBlock > 1;
    pieces.push({
      kind: "run",
      nodes: run,
      slotBefore: lastBlock + 1,
      slotAfter: replacesOriginal ? nextBlock : lastBlock + 1,
    });
    run = [];
  };

  let index = 0;
  while (index < nodes.length) {
    const block = untouchedBlockAtCurrent.get(index);
    if (block !== undefined && block > lastBlock) {
      flushRun(block);
      pieces.push({ kind: "block", block });
      lastBlock = block;
      const sourceBlock = snapshot.blocks[block];
      index += sourceBlock ? sourceBlock.nodeEnd - sourceBlock.nodeStart : 1;
      continue;
    }

    run.push(index);
    index += 1;
  }
  flushRun(snapshot.blocks.length);

  for (const piece of pieces) {
    if (piece.kind !== "block") continue;
    const block = snapshot.blocks[piece.block];
    if (!block) continue;
    for (let node = block.nodeStart; node < block.nodeEnd; node += 1) {
      const original = snapshot.nodes[node];
      if (original) options.onUntouchedNode?.(original);
    }
  }

  const slots = snapshot.slots;
  const lastSlot = slots.length - 1;
  const slotText = (slot: number) => slots[slot] ?? "";
  const droppedContent = (fromSlot: number, toSlot: number) => {
    let content = "";
    for (let slot = fromSlot; slot <= toSlot; slot += 1) {
      content += contentOfSlot(slotText(slot));
    }
    return content;
  };

  let output = slotText(0);
  let previousType: string | null = null;
  let previousSlotAfter = 0;
  let wroteAnything = false;

  const writeSeparatorBefore = (slotBefore: number, nextType: string) => {
    if (!wroteAnything) {
      if (slotBefore > 0) output += droppedContent(1, slotBefore);
      return;
    }

    const separator =
      slotBefore === previousSlotAfter
        ? slotText(slotBefore)
        : slotText(previousSlotAfter) +
          droppedContent(previousSlotAfter + 1, slotBefore);
    output += joinSeparator(separator, previousType, nextType);
  };

  for (const piece of pieces) {
    if (piece.kind === "block") {
      const block = snapshot.blocks[piece.block];
      if (!block) continue;
      writeSeparatorBefore(piece.block, block.firstType);
      output += block.source;
      previousType = block.lastType;
      previousSlotAfter = piece.block + 1;
      wroteAnything = true;
      continue;
    }

    const serialized = piece.nodes
      .map((nodeIndex) => {
        const node = nodes[nodeIndex];
        return node
          ? { node, markdown: options.serializeNode(node).trim() }
          : null;
      })
      .filter(
        (entry): entry is { node: JSONContent; markdown: string } =>
          entry !== null && entry.markdown.length > 0,
      );

    if (serialized.length === 0) {
      continue;
    }

    serialized.forEach((entry, entryIndex) => {
      const type = entry.node.type ?? "paragraph";
      if (entryIndex === 0) {
        writeSeparatorBefore(piece.slotBefore, type);
      } else {
        output += "\n\n";
      }
      output += entry.markdown;
      previousType = type;
      wroteAnything = true;
    });
    previousSlotAfter = piece.slotAfter;
  }

  if (!wroteAnything) {
    return output + droppedContent(1, lastSlot - 1) + slotText(lastSlot);
  }

  if (previousSlotAfter < lastSlot) {
    const dropped = droppedContent(previousSlotAfter, lastSlot - 1);
    if (dropped) {
      output += joinSeparator("\n\n", previousType, "paragraph");
      output += dropped.replace(/\s*$/, "");
    }
  }

  const trailing = slotText(lastSlot);
  return output + (trailing || (output.endsWith("\n") ? "" : "\n"));
}
