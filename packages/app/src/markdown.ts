import { tables, taskListItems } from "@joplin/turndown-plugin-gfm";
import { Marked, marked, type TokenizerObject } from "marked";
import TurndownService from "turndown";
import {
  findDetailsBlocks,
  findFencedCodeRanges,
  findHtmlCommentBlocks,
  type MarkdownBlockSpan,
  transformOutsideFencedCode,
} from "./markdown-fences";
import { isReviewEndmatter, parseReviewEndmatter } from "./review-endmatter";

export const rawMarkdownBlockAttribute = "data-markdown-raw-block";

export interface MarkdownOptions {
  resolveFileUrl?: (path: string) => string | null;
  resolveLinkUrl?: (path: string) => string | null;
}

export interface YamlFrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

export interface YamlDocumentMetadataSplit {
  frontmatter: string | null;
  body: string;
  endmatter: string | null;
  /**
   * The body exactly as it appears on disk. When endmatter exists, `body`
   * normalizes the whitespace before the endmatter delimiter; `rawBody` keeps
   * it, so that `rawBody + "\n" + endmatter` is the original text.
   */
  rawBody: string;
}

function isExternalUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//");
}

function isInPageAnchor(path: string): boolean {
  return path.startsWith("#");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function encodeRawMarkdownBlock(markdown: string): string {
  return encodeURIComponent(markdown);
}

export function decodeRawMarkdownBlock(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function createRawMarkdownBlock(markdown: string): string {
  return `<div ${rawMarkdownBlockAttribute}="${escapeHtml(
    encodeRawMarkdownBlock(markdown),
  )}"></div>\n`;
}

const rawMarkdownBlockPlaceholderPattern = new RegExp(
  `<div ${rawMarkdownBlockAttribute}="([^"]*)"></div>(\\n?)`,
  "g",
);

/**
 * Turns raw-block placeholders created by `protectRichTextRoundTripMarkdown`
 * back into the markdown they stand for.
 */
export function decodeRawMarkdownPlaceholders(markdown: string): string {
  return markdown.replace(
    rawMarkdownBlockPlaceholderPattern,
    (_match, encoded: string, newline: string) => {
      const original = decodeRawMarkdownBlock(encoded);
      return newline ? original : original.replace(/\r?\n$/, "");
    },
  );
}

function replaceSpans(markdown: string, spans: MarkdownBlockSpan[]): string {
  if (spans.length === 0) return markdown;

  let output = "";
  let cursor = 0;
  for (const span of [...spans].sort(
    (left, right) => left.start - right.start,
  )) {
    if (span.start < cursor) continue;
    output += markdown.slice(cursor, span.start);
    output += createRawMarkdownBlock(markdown.slice(span.start, span.end));
    cursor = span.end;
  }

  return output + markdown.slice(cursor);
}

function protectRawHtmlBlocks(markdown: string): string {
  const withDetailsProtected = replaceSpans(
    markdown,
    findDetailsBlocks(markdown),
  );
  return replaceSpans(
    withDetailsProtected,
    findHtmlCommentBlocks(withDetailsProtected),
  );
}

function protectIndentedCodeAfterLists(markdown: string): string {
  return transformOutsideFencedCode(markdown, (segment) =>
    segment.replace(
      /^(?:[-*+]|\d+[.)]) [^\r\n]*(?:\r?\n)[ \t]*(?:\r?\n)(?:(?: {4}|\t)[^\r\n]*(?:\r?\n|$))+/gm,
      (raw) => createRawMarkdownBlock(raw),
    ),
  );
}

// Ported from peterhartree/roughdraft d4c6c30: pair backtick runs of equal
// length, so adjacent cells with inline code are not mistaken for a code span
// that contains the cell separator.
function codeSpanContainsPipe(value: string): boolean {
  const runs = Array.from(value.matchAll(/`+/g), (match) => ({
    start: match.index,
    length: match[0].length,
  }));

  for (let openingIndex = 0; openingIndex < runs.length; openingIndex += 1) {
    const opening = runs[openingIndex];
    if (!opening) continue;

    for (
      let closingIndex = openingIndex + 1;
      closingIndex < runs.length;
      closingIndex += 1
    ) {
      const closing = runs[closingIndex];
      if (!closing || closing.length !== opening.length) continue;

      if (
        value.slice(opening.start + opening.length, closing.start).includes("|")
      ) {
        return true;
      }

      openingIndex = closingIndex;
      break;
    }
  }

  return false;
}

function protectPipeSensitiveTables(markdown: string): string {
  const lines = markdown.match(/[^\r\n]*(?:\r?\n|$)/g) ?? [];
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";

    if (
      !line.includes("|") ||
      !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)
    ) {
      output.push(line);
      continue;
    }

    const tableLines = [line, nextLine];
    index += 2;

    while (index < lines.length) {
      const row = lines[index] ?? "";
      if (!row.trim() || !row.includes("|")) break;
      tableLines.push(row);
      index += 1;
    }

    const raw = tableLines.join("");
    const needsProtection = raw.includes("\\|") || codeSpanContainsPipe(raw);
    output.push(needsProtection ? createRawMarkdownBlock(raw) : raw);
    index -= 1;
  }

  return output.join("");
}

/**
 * Replaces constructs the rich-text editor cannot represent faithfully with
 * opaque placeholders that serialize back to their original text. Fenced
 * code is never rewritten: diffs often contain `<details>`, HTML comments or
 * table-like lines as literal text.
 */
export function protectRichTextRoundTripMarkdown(markdown: string): string {
  return transformOutsideFencedCode(
    protectIndentedCodeAfterLists(protectRawHtmlBlocks(markdown)),
    protectPipeSensitiveTables,
  );
}

function normalizeMarkdownPath(path: string): string {
  if (path.startsWith("./") || path.startsWith("../")) return path;
  return `./${path.replace(/^\/+/, "")}`;
}

function tableHasUnsupportedMarkdownContent(table: HTMLTableElement): boolean {
  return Boolean(
    table.querySelector(
      "blockquote, h1, h2, h3, h4, h5, h6, hr, ol, pre, table, ul",
    ),
  );
}

function getFirstTableRow(table: HTMLTableElement): HTMLTableRowElement | null {
  return table.rows.length > 0 ? table.rows[0] : null;
}

function isHeaderTableRow(row: HTMLTableRowElement | null): boolean {
  if (!row || row.cells.length === 0) return false;

  return Array.from(row.cells).every((cell) => cell.tagName === "TH");
}

function isMarkdownTableDivider(line: string | undefined): boolean {
  return Boolean(line && /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line));
}

function markdownTableDividerForCell(cell: HTMLTableCellElement): string {
  const alignment = (
    cell.getAttribute("align") ||
    cell.style.textAlign ||
    ""
  ).toLowerCase();

  if (alignment === "left") return ":---";
  if (alignment === "right") return "---:";
  if (alignment === "center") return ":---:";

  return "---";
}

function markdownTableDividerForRow(row: HTMLTableRowElement): string {
  const dividers = Array.from(row.cells).map(markdownTableDividerForCell);
  return `| ${dividers.join(" | ")} |`;
}

function resolveRenderedUrl(
  path: string,
  resolveFileUrl?: MarkdownOptions["resolveFileUrl"],
) {
  if (isExternalUrl(path) || isInPageAnchor(path)) return path;
  return resolveFileUrl?.(path) ?? path;
}

function isYamlFrontmatterDelimiter(line: string): boolean {
  return /^(?:---|\.\.\.)[ \t]*$/.test(line.replace(/\r$/, ""));
}

/**
 * Offset of the newline that starts the last `---` line outside fenced code,
 * or `null`. Review endmatter always starts at that line.
 */
function findFinalDelimiterOffset(body: string): number | null {
  const fences = findFencedCodeRanges(body);
  const delimiters = [...body.matchAll(/\n---[ \t]*\r?\n/g)];

  for (let index = delimiters.length - 1; index >= 0; index -= 1) {
    const match = delimiters[index];
    if (match?.index === undefined) continue;
    const lineStart = match.index + 1;
    const insideFence = fences.some(
      (range) => lineStart > range.start && lineStart < range.end,
    );
    if (!insideFence) return match.index;
  }

  return null;
}

export function splitYamlFrontmatter(markdown: string): YamlFrontmatterSplit {
  const openingDelimiter = markdown.match(/^---[ \t]*(?:\r\n|\n)/);
  if (!openingDelimiter) return { frontmatter: null, body: markdown };

  let lineStart = openingDelimiter[0].length;

  while (lineStart < markdown.length) {
    const nextLineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = nextLineBreak === -1 ? markdown.length : nextLineBreak + 1;
    const line = markdown.slice(
      lineStart,
      nextLineBreak === -1 ? lineEnd : lineEnd - 1,
    );

    if (isYamlFrontmatterDelimiter(line)) {
      let bodyStart = lineEnd;

      while (bodyStart < markdown.length) {
        const blankLineBreak = markdown.indexOf("\n", bodyStart);
        const blankLineEnd =
          blankLineBreak === -1 ? markdown.length : blankLineBreak + 1;
        const blankLine = markdown.slice(
          bodyStart,
          blankLineBreak === -1 ? blankLineEnd : blankLineEnd - 1,
        );

        if (blankLine.replace(/\r$/, "").trim() !== "") break;
        bodyStart = blankLineEnd;
      }

      return {
        frontmatter: markdown.slice(0, bodyStart),
        body: markdown.slice(bodyStart),
      };
    }

    lineStart = lineEnd;
  }

  return { frontmatter: null, body: markdown };
}

export function prependYamlFrontmatter(
  markdown: string,
  frontmatter?: string | null,
): string {
  return frontmatter ? `${frontmatter}${markdown}` : markdown;
}

export function splitYamlDocumentMetadata(
  markdown: string,
): YamlDocumentMetadataSplit {
  const { frontmatter, body } = splitYamlFrontmatter(markdown);
  const delimiterOffset = findFinalDelimiterOffset(body);

  if (delimiterOffset === null) {
    return { frontmatter, body, endmatter: null, rawBody: body };
  }

  const candidate = body.slice(delimiterOffset + 1);
  const precedingBody = body.slice(0, delimiterOffset);
  if (!isReviewEndmatter(parseReviewEndmatter(candidate), precedingBody)) {
    return { frontmatter, body, endmatter: null, rawBody: body };
  }

  return {
    frontmatter,
    body: precedingBody.replace(/\s*$/, "\n"),
    endmatter: candidate,
    rawBody: precedingBody,
  };
}

export function appendYamlEndmatter(
  markdown: string,
  endmatter?: string | null,
): string {
  return endmatter
    ? `${markdown.replace(/\s*$/, "\n")}\n${endmatter}`
    : markdown;
}

export function createMarkedRenderer(options?: MarkdownOptions) {
  const renderer = new marked.Renderer();
  const baseRenderer = new marked.Renderer();
  const resolveFileUrl = options?.resolveFileUrl;
  const resolveLinkUrl = options?.resolveLinkUrl;

  renderer.code = ({ text, lang, escaped }) => {
    const language = (lang || "").match(/\S+/)?.[0];
    const content = escaped ? text : escapeHtml(text);
    const classAttr = language
      ? ` class="language-${escapeHtml(language)}"`
      : "";

    return `<pre><code${classAttr}>${content}</code></pre>\n`;
  };

  renderer.link = function ({ href, title, tokens, raw }) {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(
      rawHref,
      (path) => resolveLinkUrl?.(path) ?? resolveFileUrl?.(path) ?? null,
    );
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;
    const autolinkAttr =
      !title && raw?.startsWith("<") && raw.endsWith(">")
        ? ' data-markdown-autolink="true"'
        : "";
    const externalAttr =
      isExternalUrl(rawHref) && !rawHref.startsWith("mailto:")
        ? ' target="_blank" rel="noreferrer noopener"'
        : "";

    return `<a href="${escapeHtml(renderedHref)}"${titleAttr}${markdownSrcAttr}${autolinkAttr}${externalAttr}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(rawHref, resolveFileUrl);
    const alt = text || "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;

    return `<img src="${escapeHtml(renderedHref)}" alt="${escapeHtml(alt)}"${titleAttr}${markdownSrcAttr}>`;
  };

  renderer.list = function (token) {
    const hasTaskItems = token.items.some((item) => item.task);
    if (!hasTaskItems) {
      return baseRenderer.list.call(this, token);
    }

    const items = token.items
      .map((item) => {
        const checked = item.checked ? "true" : "false";
        const inner = this.parser.parse(item.tokens, false);
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${
          item.checked ? ' checked="checked"' : ""
        }><span></span></label><div>${inner}</div></li>`;
      })
      .join("");

    return `<ul data-type="taskList">${items}</ul>`;
  };

  return renderer;
}

const doubleTildeDelPattern =
  /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

/**
 * Only `~~text~~` is strikethrough. GFM in marked also accepts single tildes,
 * which made saves rewrite "~57% (~100h)" as strikethrough markup (ported
 * from peterhartree/roughdraft 1daf2f7, upstream PR #135).
 */
export const markedTokenizer: TokenizerObject = {
  del(src) {
    const match = doubleTildeDelPattern.exec(src);
    if (!match) return undefined;

    const text = match[2] ?? "";
    return {
      type: "del",
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text),
    };
  },
};

export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
    blankReplacement(_content, node) {
      if (node.hasAttribute(rawMarkdownBlockAttribute)) {
        return `\n\n${decodeRawMarkdownBlock(
          node.getAttribute(rawMarkdownBlockAttribute) ?? "",
        ).trimEnd()}\n\n`;
      }

      return (node as HTMLElement & { isBlock?: boolean }).isBlock
        ? "\n\n"
        : "";
    },
  });

  service.use(tables as Parameters<TurndownService["use"]>[0]);
  service.use(taskListItems as Parameters<TurndownService["use"]>[0]);

  service.addRule("compactListItem", {
    filter: "li",
    replacement(content, node, options) {
      // Task items render their checkbox and text as separate blocks; keep
      // them on one line (ported from peterhartree/roughdraft 4618273).
      const normalizedContent =
        (node as HTMLElement).getAttribute("data-type") === "taskItem"
          ? content
              .replace(/^(\[[ xX]\])[ \t]*(?:\r?\n[ \t]*)+(?=\S)/, "$1 ")
              .trimEnd()
          : content;
      // Indent continuation lines, but never turn a blank line into a
      // whitespace-only line.
      const trimmed = collapseBlankLines(normalizedContent)
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n(?=[^\n])/g, "\n  ");

      let prefix = `${options.bulletListMarker} `;
      const parent = node.parentNode;
      if (parent && parent.nodeName === "OL") {
        const start = (parent as HTMLOListElement).getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }

      return (
        prefix +
        trimmed +
        (node.nextSibling && !/\n$/.test(trimmed) ? "\n" : "")
      );
    },
  });

  service.addRule("tiptapHeaderTable", {
    filter(node) {
      if (node.tagName !== "TABLE") return false;

      const table = node as HTMLTableElement;
      return (
        !tableHasUnsupportedMarkdownContent(table) &&
        isHeaderTableRow(getFirstTableRow(table))
      );
    },
    replacement(content, node) {
      const table = node as HTMLTableElement;
      const headerRow = getFirstTableRow(table);
      if (!headerRow) return content;

      const lines = content.replace(/\n+/g, "\n").trim().split("\n");
      if (lines.length === 0) return content;

      if (!isMarkdownTableDivider(lines[1])) {
        lines.splice(1, 0, markdownTableDividerForRow(headerRow));
      }

      const captionContent = table.caption?.textContent || "";
      const caption = captionContent ? `${captionContent}\n\n` : "";

      return `\n\n${caption}${lines.join("\n")}\n\n`;
    },
  });

  // We own the markdown parser and want stable round-trips without doubled escapes.
  service.escape = (value: string) => value;

  service.addRule("markdownAwareLinks", {
    filter: "a",
    replacement(content, node) {
      const element = node as HTMLAnchorElement;
      const href =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("href") ||
        "";
      const normalizedHref =
        isExternalUrl(href) || isInPageAnchor(href)
          ? href
          : normalizeMarkdownPath(href);
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";

      if (
        element.getAttribute("data-markdown-autolink") === "true" &&
        !titleMarkdown
      ) {
        return href.startsWith("mailto:")
          ? `<${href.slice("mailto:".length)}>`
          : `<${normalizedHref}>`;
      }

      return `[${content}](${normalizedHref}${titleMarkdown})`;
    },
  });

  service.addRule("markdownAwareImages", {
    filter: "img",
    replacement(_content, node) {
      const element = node as HTMLImageElement;
      const src =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("src") ||
        "";
      const normalizedSrc = isExternalUrl(src)
        ? src
        : normalizeMarkdownPath(src);
      const alt = element.getAttribute("alt") || "";
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";
      return `![${alt}](${normalizedSrc}${titleMarkdown})`;
    },
  });

  service.addRule("markdownStrikethrough", {
    filter: (node) =>
      node.nodeName === "DEL" ||
      node.nodeName === "S" ||
      node.nodeName === "STRIKE",
    replacement(content) {
      return `~~${content}~~`;
    },
  });

  service.addRule("rawMarkdownBlock", {
    filter: (node) =>
      node.nodeType === 1 &&
      (node as HTMLElement).hasAttribute(rawMarkdownBlockAttribute),
    replacement(_content, node) {
      const encoded =
        (node as HTMLElement).getAttribute(rawMarkdownBlockAttribute) ?? "";
      return `\n\n${decodeRawMarkdownBlock(encoded).trimEnd()}\n\n`;
    },
  });

  return service;
}

const turndown = createTurndownService();

/**
 * Collapse runs of 3+ newlines to 2 and remove the blank line that
 * Turndown inserts before/after ATX headings.  This keeps block
 * separation where it matters (between consecutive paragraphs) while
 * producing a more compact output that round-trips with fewer
 * gratuitous whitespace changes.
 */
export function normalizeBlockSpacing(md: string): string {
  // Fenced code is content: its blank lines and `# comment` lines must not be
  // touched.
  return transformOutsideFencedCode(md, (segment) => {
    let normalized = segment.replace(/\n{3,}/g, "\n\n");
    // Remove blank line immediately before a heading.
    normalized = normalized.replace(/\n\n(#{1,6} )/g, "\n$1");
    // Remove blank line immediately after a heading line.
    normalized = normalized.replace(/(^#{1,6} [^\n]+)\n\n/gm, "$1\n");
    return normalized;
  });
}

/**
 * Collapses runs of blank lines outside fenced code. Used for blocks that are
 * re-serialized on their own, where heading spacing comes from the original
 * document instead.
 */
export function collapseBlankLines(md: string): string {
  return transformOutsideFencedCode(md, (segment) =>
    segment.replace(/\n{3,}/g, "\n\n"),
  );
}

export function toMarkdown(html: string): string {
  return normalizeBlockSpacing(`${turndown.turndown(html).trimEnd()}\n`);
}

export function toHtml(markdown: string, options?: MarkdownOptions): string {
  const parser = new Marked({
    async: false,
    gfm: true,
    renderer: createMarkedRenderer(options),
  });
  parser.use({ tokenizer: markedTokenizer });

  return parser.parse(markdown) as string;
}
