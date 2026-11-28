/**
 * Change detection between two versions of a document: what is new, changed or
 * removed, ignoring review marks (CriticMarkup comments, highlights and
 * suggestions) and the YAML endmatter. A new comment is not a change.
 *
 * This file has no dependencies on the rest of the package so the app can
 * import it directly. Two layers:
 *  - `diffTextBlocks`: the algorithm, over plain-text blocks (the app feeds it
 *    the text blocks of its editor document so positions line up exactly).
 *  - `diffRoughdraftDocuments`: markdown in, changes out (the CLI uses it).
 */

export type RfmDiffBlockKind =
  | "paragraph"
  | "heading"
  | "list-item"
  | "table-cell"
  | "code";

export interface RfmDiffRange {
  /** Offset into the new text, inclusive. */
  start: number;
  /** Offset into the new text, exclusive. */
  end: number;
}

export interface RfmDiffBlock {
  kind: RfmDiffBlockKind;
  /** 1-based line in the markdown where the block starts. */
  line: number;
  /** The block as plain text: no markdown syntax, no review marks. */
  text: string;
}

export type RfmBlockStatus = "same" | "added" | "changed";

export interface RfmNewBlockDiff {
  status: RfmBlockStatus;
  /** Index of the baseline block it was matched with; null when added. */
  oldIndex: number | null;
  /** Changed words of a "changed" block, as ranges into its new text. */
  ranges: RfmDiffRange[];
}

export interface RfmRemovedBlock {
  /** Index into the baseline blocks. */
  oldIndex: number;
  /** Index of the new block the removal sits in front of; `newBlocks.length` for the end. */
  beforeNewIndex: number;
}

export interface RfmTextBlocksDiff {
  /** One entry per new block, in order. */
  blocks: RfmNewBlockDiff[];
  removed: RfmRemovedBlock[];
}

export interface RfmDocumentChange {
  kind: "added" | "changed" | "removed";
  blockKind: RfmDiffBlockKind;
  /**
   * 1-based line in the current document. For "removed" it is the line of the
   * block the removal sits in front of (one past the last line when the
   * removal is at the end).
   */
  line: number;
  /** 1-based line in the baseline; null for "added". */
  oldLine: number | null;
  /** Baseline text; "" for "added". */
  oldText: string;
  /** Current text; "" for "removed". */
  newText: string;
  /** Changed words as ranges into `newText`; [] unless "changed". */
  ranges: RfmDiffRange[];
}

export interface RfmDocumentDiffSummary {
  added: number;
  changed: number;
  removed: number;
  /** added + changed + removed */
  total: number;
  unchanged: number;
}

export interface RfmDocumentDiff {
  changes: RfmDocumentChange[];
  summary: RfmDocumentDiffSummary;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

/** A block pairs with a baseline block when at least this share of words match. */
const PAIR_SIMILARITY = 0.5;
const MAX_LCS_CELLS = 16_000_000;
const MAX_PAIRING_CELLS = 250_000;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\S+/g;
  let match = pattern.exec(text);
  while (match) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
    match = pattern.exec(text);
  }
  return tokens;
}

function blockKey(text: string): string {
  return tokenize(text)
    .map((token) => token.text)
    .join(" ");
}

function wordCore(token: Token): string {
  const core = token.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return (core || token.text).toLowerCase();
}

/** Longest-common-subsequence pairs `[aIndex, bIndex]`, in order. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pairs.push([start, start]);
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  const tail: Array<[number, number]> = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    tail.push([endA, endB]);
  }

  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= MAX_LCS_CELLS) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[start + i] === b[start + j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(
                table[(i + 1) * width + j] ?? 0,
                table[i * width + j + 1] ?? 0,
              );
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i += 1;
        j += 1;
      } else if (
        (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
      ) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }

  tail.reverse();
  return pairs.concat(tail);
}

function wordSimilarity(a: Token[], b: Token[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Punctuation does not decide whether two blocks are the same block.
  const common = lcsPairs(a.map(wordCore), b.map(wordCore)).length;
  return (2 * common) / (a.length + b.length);
}

/** Words of `newText` that are not part of the longest run shared with `oldText`. */
export function diffWordRanges(
  oldText: string,
  newText: string,
): RfmDiffRange[] {
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  const kept = new Set(
    lcsPairs(
      oldTokens.map((token) => token.text),
      newTokens.map((token) => token.text),
    ).map(([, newIndex]) => newIndex),
  );

  const ranges: RfmDiffRange[] = [];
  let open: RfmDiffRange | null = null;
  newTokens.forEach((token, index) => {
    if (kept.has(index)) {
      open = null;
      return;
    }
    if (open) {
      open.end = token.end;
    } else {
      open = { start: token.start, end: token.end };
      ranges.push(open);
    }
  });
  return ranges;
}

/**
 * Pairs the leftover baseline and current blocks of one gap between two
 * identical blocks, keeping their order, so an edited paragraph shows as
 * "changed" instead of removed plus added.
 */
function pairGap(
  oldTexts: string[],
  newTexts: string[],
  oldIndexes: number[],
  newIndexes: number[],
): Array<[number, number]> {
  const n = oldIndexes.length;
  const m = newIndexes.length;
  if (n === 0 || m === 0) return [];

  if (n * m > MAX_PAIRING_CELLS) {
    if (n !== m) return [];
    // Too large to score every pair: same-position blocks that still look alike.
    const pairs: Array<[number, number]> = [];
    for (let k = 0; k < n; k += 1) {
      const oldIndex = oldIndexes[k] as number;
      const newIndex = newIndexes[k] as number;
      if (
        wordSimilarity(
          tokenize(oldTexts[oldIndex] ?? ""),
          tokenize(newTexts[newIndex] ?? ""),
        ) >= PAIR_SIMILARITY
      ) {
        pairs.push([oldIndex, newIndex]);
      }
    }
    return pairs;
  }

  const oldTokens = oldIndexes.map((index) => tokenize(oldTexts[index] ?? ""));
  const newTokens = newIndexes.map((index) => tokenize(newTexts[index] ?? ""));
  const width = m + 1;
  const score = new Float64Array((n + 1) * width);
  const sim = new Float64Array(n * m);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      const value = wordSimilarity(
        oldTokens[i] as Token[],
        newTokens[j] as Token[],
      );
      sim[i * m + j] = value >= PAIR_SIMILARITY ? value : 0;
    }
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const pair = sim[i * m + j] ?? 0;
      score[i * width + j] = Math.max(
        score[(i + 1) * width + j] ?? 0,
        score[i * width + j + 1] ?? 0,
        pair > 0 ? pair + (score[(i + 1) * width + j + 1] ?? 0) : 0,
      );
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const pair = sim[i * m + j] ?? 0;
    const here = score[i * width + j] ?? 0;
    if (
      pair > 0 &&
      Math.abs(here - (pair + (score[(i + 1) * width + j + 1] ?? 0))) < 1e-9
    ) {
      pairs.push([oldIndexes[i] as number, newIndexes[j] as number]);
      i += 1;
      j += 1;
    } else if (
      (score[(i + 1) * width + j] ?? 0) >= (score[i * width + j + 1] ?? 0)
    ) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return fillEqualSubgaps(pairs, oldIndexes, newIndexes);
}

/**
 * Between two paired blocks (or the ends of the gap), the same number of
 * leftover blocks on both sides were edited in place: pair them by position.
 */
function fillEqualSubgaps(
  pairs: Array<[number, number]>,
  oldIndexes: number[],
  newIndexes: number[],
): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let oldPos = 0;
  let newPos = 0;
  const sweep = (oldEnd: number, newEnd: number) => {
    if (oldEnd - oldPos === newEnd - newPos) {
      for (; oldPos < oldEnd; oldPos += 1, newPos += 1) {
        result.push([
          oldIndexes[oldPos] as number,
          newIndexes[newPos] as number,
        ]);
      }
    }
  };
  for (const [oldIndex, newIndex] of pairs) {
    const oldAt = oldIndexes.indexOf(oldIndex);
    const newAt = newIndexes.indexOf(newIndex);
    sweep(oldAt, newAt);
    result.push([oldIndex, newIndex]);
    oldPos = oldAt + 1;
    newPos = newAt + 1;
  }
  sweep(oldIndexes.length, newIndexes.length);
  return result;
}

/**
 * The algorithm over plain-text blocks. Blocks are compared word by word with
 * whitespace ignored. A block moved elsewhere unchanged counts as unchanged
 * (the reader has already read it); only text that is new, edited or gone
 * is reported.
 */
export function diffTextBlocks(
  oldTexts: string[],
  newTexts: string[],
): RfmTextBlocksDiff {
  const oldKeys = oldTexts.map(blockKey);
  const newKeys = newTexts.map(blockKey);

  const oldMatched: Array<number | null> = oldTexts.map(() => null);
  const newMatched: Array<number | null> = newTexts.map(() => null);
  const changedPair = new Set<number>();

  const anchors = lcsPairs(oldKeys, newKeys);
  for (const [oldIndex, newIndex] of anchors) {
    oldMatched[oldIndex] = newIndex;
    newMatched[newIndex] = oldIndex;
  }

  // The gaps between consecutive anchors.
  const bounds: Array<[number, number]> = [
    ...anchors,
    [oldTexts.length, newTexts.length],
  ];
  let prevOld = -1;
  let prevNew = -1;
  for (const [anchorOld, anchorNew] of bounds) {
    const oldGap: number[] = [];
    const newGap: number[] = [];
    for (let k = prevOld + 1; k < anchorOld; k += 1) oldGap.push(k);
    for (let k = prevNew + 1; k < anchorNew; k += 1) newGap.push(k);
    for (const [oldIndex, newIndex] of pairGap(
      oldTexts,
      newTexts,
      oldGap,
      newGap,
    )) {
      oldMatched[oldIndex] = newIndex;
      newMatched[newIndex] = oldIndex;
      changedPair.add(newIndex);
    }
    prevOld = anchorOld;
    prevNew = anchorNew;
  }

  // Moved blocks: identical text on both sides, left unmatched by the order
  // constraint. They are not changes.
  const unmatchedOldByKey = new Map<string, number[]>();
  oldKeys.forEach((key, index) => {
    if (oldMatched[index] !== null || key === "") return;
    const list = unmatchedOldByKey.get(key) ?? [];
    list.push(index);
    unmatchedOldByKey.set(key, list);
  });
  newKeys.forEach((key, newIndex) => {
    if (newMatched[newIndex] !== null) return;
    const oldIndex = unmatchedOldByKey.get(key)?.shift();
    if (oldIndex === undefined) return;
    oldMatched[oldIndex] = newIndex;
    newMatched[newIndex] = oldIndex;
  });

  const blocks: RfmNewBlockDiff[] = newTexts.map((text, newIndex) => {
    const oldIndex = newMatched[newIndex] ?? null;
    if (oldIndex === null) {
      return { status: "added", oldIndex: null, ranges: [] };
    }
    if (!changedPair.has(newIndex)) {
      return { status: "same", oldIndex, ranges: [] };
    }
    return {
      status: "changed",
      oldIndex,
      ranges: diffWordRanges(oldTexts[oldIndex] ?? "", text),
    };
  });

  const removed: RfmRemovedBlock[] = [];
  let nextNew = 0;
  for (let oldIndex = 0; oldIndex < oldTexts.length; oldIndex += 1) {
    const matched = oldMatched[oldIndex];
    if (matched !== null && matched !== undefined) {
      nextNew = matched + 1;
      continue;
    }
    if (oldKeys[oldIndex] === "") continue;
    removed.push({ oldIndex, beforeNewIndex: nextNew });
  }

  return { blocks, removed };
}

// ---------------------------------------------------------------------------
// Markdown to plain-text blocks

/**
 * The markdown without review marks and endmatter: CriticMarkup comments (and
 * their metadata) are dropped, highlights keep their text, additions are
 * dropped, deletions and substitutions keep the original text. Fenced code is
 * left alone.
 */
export function stripRoughdraftReviewMarks(markdown: string): string {
  let body = markdown;
  const endmatters = [...body.matchAll(/\n---[ \t]*\r?\n/g)];
  const last = endmatters.at(-1);
  if (last?.index !== undefined) {
    const tail = body.slice(last.index).replace(/^\n---[ \t]*\r?\n/, "");
    if (/^(comments|suggestions|deleted)[ \t]*:/m.test(tail)) {
      body = body.slice(0, last.index);
    }
  }

  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let pending: string[] = [];
  let fence: { char: string; length: number } | null = null;

  const flushPending = () => {
    if (pending.length === 0) return;
    out.push(stripInlineMarks(pending.join("\n")));
    pending = [];
  };

  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (
        match &&
        (match[1] as string)[0] === fence.char &&
        (match[1] as string).length >= fence.length &&
        line.trim() === match[1]
      ) {
        fence = null;
      }
      continue;
    }
    if (match) {
      flushPending();
      fence = {
        char: (match[1] as string)[0] as string,
        length: (match[1] as string).length,
      };
      out.push(line);
      continue;
    }
    pending.push(line);
  }
  flushPending();
  return out.join("\n");
}

const MARK_METADATA = String.raw`(?:\{#[\w.-]+\}|\{[a-z][\w-]*="[^}]*\})?`;

function stripInlineMarks(text: string): string {
  return text
    .replace(new RegExp(String.raw`\{>>[\s\S]*?<<\}${MARK_METADATA}`, "g"), "")
    .replace(
      new RegExp(String.raw`\{==([\s\S]*?)==\}${MARK_METADATA}`, "g"),
      "$1",
    )
    .replace(
      new RegExp(String.raw`\{\+\+[\s\S]*?\+\+\}${MARK_METADATA}`, "g"),
      "",
    )
    .replace(
      new RegExp(String.raw`\{--([\s\S]*?)--\}${MARK_METADATA}`, "g"),
      "$1",
    )
    .replace(
      new RegExp(String.raw`\{~~([\s\S]*?)~>[\s\S]*?~~\}${MARK_METADATA}`, "g"),
      "$1",
    );
}

/** Inline markdown to plain text: the words a reader sees. */
function plainInline(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?:|mailto:)[^>]+)>/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;
const HEADING = /^\s{0,3}#{1,6}(?:\s+|$)/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * Splits markdown into the plain-text blocks the diff compares: paragraphs,
 * headings, list items, table cells and code blocks. Review marks and
 * endmatter are removed first.
 */
export function extractDiffBlocks(markdown: string): RfmDiffBlock[] {
  const lines = stripRoughdraftReviewMarks(markdown).split(/\r?\n/);
  const blocks: RfmDiffBlock[] = [];
  let paragraph: { kind: RfmDiffBlockKind; line: number; text: string } | null =
    null;
  let fence: {
    char: string;
    length: number;
    line: number;
    lines: string[];
  } | null = null;

  const flush = () => {
    if (!paragraph) return;
    const text = plainInline(paragraph.text);
    if (text) blocks.push({ kind: paragraph.kind, line: paragraph.line, text });
    paragraph = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index] ?? "";

    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(raw);
      if (
        close &&
        (close[1] as string)[0] === fence.char &&
        (close[1] as string).length >= fence.length
      ) {
        const text = fence.lines.join("\n");
        if (text.trim()) {
          blocks.push({ kind: "code", line: fence.line, text });
        }
        fence = null;
      } else {
        fence.lines.push(raw);
      }
      continue;
    }

    const line = raw.replace(/^(\s*>)+\s?/, "");

    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      flush();
      fence = {
        char: (open[1] as string)[0] as string,
        length: (open[1] as string).length,
        line: lineNumber,
        lines: [],
      };
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      const text = plainInline(
        line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s+#+\s*$/, ""),
      );
      if (text) blocks.push({ kind: "heading", line: lineNumber, text });
      continue;
    }
    if (HR.test(line) && !LIST_MARKER.test(line)) {
      flush();
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      flush();
      if (TABLE_SEPARATOR.test(line)) continue;
      for (const cell of splitTableCells(line)) {
        const text = plainInline(cell);
        if (text) blocks.push({ kind: "table-cell", line: lineNumber, text });
      }
      continue;
    }
    if (LIST_MARKER.test(line)) {
      flush();
      paragraph = {
        kind: "list-item",
        line: lineNumber,
        text: line.replace(LIST_MARKER, ""),
      };
      continue;
    }
    if (paragraph) {
      paragraph.text += ` ${line.trim()}`;
    } else {
      paragraph = { kind: "paragraph", line: lineNumber, text: line.trim() };
    }
  }

  if (fence) {
    const open = fence as { line: number; lines: string[] };
    const text = open.lines.join("\n");
    if (text.trim()) blocks.push({ kind: "code", line: open.line, text });
  }
  flush();
  return blocks;
}

/**
 * What is new, changed or removed in `current` compared with `baseline`,
 * both markdown. Review marks and endmatter are ignored, so a new comment is
 * not a change.
 */
export function diffRoughdraftDocuments(
  baseline: string,
  current: string,
): RfmDocumentDiff {
  const oldBlocks = extractDiffBlocks(baseline);
  const newBlocks = extractDiffBlocks(current);
  const diff = diffTextBlocks(
    oldBlocks.map((block) => block.text),
    newBlocks.map((block) => block.text),
  );
  const endLine = current.split(/\r?\n/).length + 1;

  const changes: RfmDocumentChange[] = [];
  diff.blocks.forEach((result, index) => {
    const block = newBlocks[index] as RfmDiffBlock;
    if (result.status === "same") return;
    const old = result.oldIndex === null ? null : oldBlocks[result.oldIndex];
    changes.push({
      kind: result.status,
      blockKind: block.kind,
      line: block.line,
      oldLine: old?.line ?? null,
      oldText: old?.text ?? "",
      newText: block.text,
      ranges: result.ranges,
    });
  });
  for (const removal of diff.removed) {
    const old = oldBlocks[removal.oldIndex] as RfmDiffBlock;
    changes.push({
      kind: "removed",
      blockKind: old.kind,
      line: newBlocks[removal.beforeNewIndex]?.line ?? endLine,
      oldLine: old.line,
      oldText: old.text,
      newText: "",
      ranges: [],
    });
  }
  changes.sort((a, b) => a.line - b.line);

  const count = (kind: RfmDocumentChange["kind"]) =>
    changes.filter((change) => change.kind === kind).length;
  const added = count("added");
  const changed = count("changed");
  const removed = count("removed");
  return {
    changes,
    summary: {
      added,
      changed,
      removed,
      total: added + changed + removed,
      unchanged: diff.blocks.filter((block) => block.status === "same").length,
    },
  };
}
