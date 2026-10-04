/**
 * Fence-aware helpers for markdown source text.
 *
 * Several round-trip protections rewrite markdown with regular expressions
 * before it is parsed. Those rewrites must never reach inside fenced code
 * blocks, where review documents often carry diffs that contain other fences,
 * `<details>` tags or HTML comments as literal text.
 */

export interface FencedCodeRange {
  /** Offset of the first character of the opening fence line. */
  start: number;
  /** Offset just past the closing fence line (or the end of the input). */
  end: number;
}

interface LineInfo {
  text: string;
  start: number;
  /** Offset just past the line, including its line break. */
  end: number;
}

const openingFencePattern = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/;
const closingFencePattern = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function splitLines(markdown: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;

  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline + 1;
    const text = markdown.slice(start, newline === -1 ? end : newline);
    lines.push({ text: text.replace(/\r$/, ""), start, end });
    start = end;
  }

  return lines;
}

interface OpenFence {
  marker: "`" | "~";
  length: number;
}

function matchOpeningFence(text: string): OpenFence | null {
  const match = text.match(openingFencePattern);
  if (!match) return null;

  const markerText = match[2] ?? "";
  const marker = markerText[0] as "`" | "~";
  const info = match[3] ?? "";
  // CommonMark: the info string of a backtick fence cannot contain backticks.
  if (marker === "`" && info.includes("`")) return null;

  return { marker, length: markerText.length };
}

function isClosingFence(text: string, fence: OpenFence): boolean {
  const match = text.match(closingFencePattern);
  if (!match) return false;

  const markerText = match[1] ?? "";
  return markerText[0] === fence.marker && markerText.length >= fence.length;
}

/**
 * Returns the fenced code blocks of a markdown document, following the
 * CommonMark rules for fence length: a block opened with four backticks is
 * only closed by a line of at least four backticks, so ``` lines inside it are
 * plain content. Unclosed fences run to the end of the input.
 */
export function findFencedCodeRanges(markdown: string): FencedCodeRange[] {
  const ranges: FencedCodeRange[] = [];
  let open: (OpenFence & { start: number }) | null = null;

  for (const line of splitLines(markdown)) {
    if (!open) {
      const fence = matchOpeningFence(line.text);
      if (fence) open = { ...fence, start: line.start };
      continue;
    }

    if (isClosingFence(line.text, open)) {
      ranges.push({ start: open.start, end: line.end });
      open = null;
    }
  }

  if (open) {
    ranges.push({ start: open.start, end: markdown.length });
  }

  return ranges;
}

export function isOffsetInRanges(
  offset: number,
  ranges: readonly FencedCodeRange[],
): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

/**
 * Applies `transform` to the parts of `markdown` that are outside fenced code
 * blocks and leaves fenced code untouched.
 */
export function transformOutsideFencedCode(
  markdown: string,
  transform: (segment: string) => string,
): string {
  const ranges = findFencedCodeRanges(markdown);
  if (ranges.length === 0) return transform(markdown);

  let output = "";
  let cursor = 0;

  for (const range of ranges) {
    output += transform(markdown.slice(cursor, range.start));
    output += markdown.slice(range.start, range.end);
    cursor = range.end;
  }

  return output + transform(markdown.slice(cursor));
}

export interface MarkdownBlockSpan {
  start: number;
  end: number;
}

/**
 * Finds `<details>` blocks that start at the beginning of a line outside
 * fenced code. Nested `<details>` and fenced code inside the block are
 * respected, so a `</details>` line inside a fenced diff does not end the
 * block early. Blocks without a matching close are ignored.
 */
export function findDetailsBlocks(markdown: string): MarkdownBlockSpan[] {
  const lines = splitLines(markdown);
  const blocks: MarkdownBlockSpan[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;

    const fence = matchOpeningFence(line.text);
    if (fence) {
      index = skipFence(lines, index, fence);
      continue;
    }

    if (!/^[ \t]*<details\b/i.test(line.text)) {
      index += 1;
      continue;
    }

    const endIndex = findDetailsEnd(lines, index);
    if (endIndex === null) {
      index += 1;
      continue;
    }

    blocks.push({
      start: line.start,
      end: lines[endIndex]?.end ?? markdown.length,
    });
    index = endIndex + 1;
  }

  return blocks;
}

function skipFence(lines: LineInfo[], openIndex: number, fence: OpenFence) {
  for (let index = openIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && isClosingFence(line.text, fence)) return index + 1;
  }

  return lines.length;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function findDetailsEnd(lines: LineInfo[], openIndex: number): number | null {
  let depth = 0;
  let index = openIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;

    if (index !== openIndex) {
      const fence = matchOpeningFence(line.text);
      if (fence) {
        index = skipFence(lines, index, fence);
        continue;
      }
    }

    depth += countMatches(line.text, /<details\b/gi);
    depth -= countMatches(line.text, /<\/details\s*>/gi);
    if (depth <= 0) {
      return /<\/details\s*>[ \t]*$/i.test(line.text) ? index : null;
    }

    index += 1;
  }

  return null;
}

/**
 * Finds HTML comment blocks (`<!-- ... -->`) that start at the beginning of a
 * line outside fenced code and end at the end of a line.
 */
export function findHtmlCommentBlocks(markdown: string): MarkdownBlockSpan[] {
  const lines = splitLines(markdown);
  const blocks: MarkdownBlockSpan[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;

    const fence = matchOpeningFence(line.text);
    if (fence) {
      index = skipFence(lines, index, fence);
      continue;
    }

    if (!/^[ \t]*<!--/.test(line.text)) {
      index += 1;
      continue;
    }

    let endIndex: number | null = null;
    const openOffset = line.text.indexOf("<!--");
    for (let candidate = index; candidate < lines.length; candidate += 1) {
      const candidateLine = lines[candidate];
      if (!candidateLine) break;
      const searchFrom = candidate === index ? openOffset + 4 : 0;
      const closeOffset = candidateLine.text.indexOf("-->", searchFrom);
      if (
        closeOffset !== -1 &&
        /^[ \t]*$/.test(candidateLine.text.slice(closeOffset + 3))
      ) {
        endIndex = candidate;
        break;
      }
    }

    if (endIndex === null) {
      index += 1;
      continue;
    }

    blocks.push({
      start: line.start,
      end: lines[endIndex]?.end ?? markdown.length,
    });
    index = endIndex + 1;
  }

  return blocks;
}

/**
 * Picks a fence for a code block body: the preferred fence when it is safe,
 * otherwise one character longer than the longest same-character run that
 * starts a line of the body, so the body can never close the block early.
 */
export function chooseCodeFence(body: string, preferredFence?: string | null) {
  const preferred =
    preferredFence && /^(`{3,}|~{3,})$/.test(preferredFence)
      ? preferredFence
      : "```";
  const marker = preferred[0] ?? "`";
  let longest = 0;

  for (const match of body.matchAll(/^ {0,3}([`~]{3,})/gm)) {
    const run = match[1] ?? "";
    if (run[0] !== marker) continue;
    const sameMarkerRun = run.match(marker === "`" ? /^`+/ : /^~+/)?.[0] ?? "";
    longest = Math.max(longest, sameMarkerRun.length);
  }

  return longest >= preferred.length ? marker.repeat(longest + 1) : preferred;
}
