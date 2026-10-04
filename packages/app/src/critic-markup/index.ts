import {
  elementFromString,
  getHTMLFromFragment,
  getSchema,
  type JSONContent,
} from "@tiptap/core";
import {
  Fragment,
  DOMParser as ProseMirrorDOMParser,
  Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import {
  Marked,
  type RendererThis,
  type Token,
  type TokenizerAndRendererExtension,
  type TokenizerThis,
  type Tokens,
} from "marked";
import type TurndownService from "turndown";
import {
  createEditorExtensions,
  type CriticChangeAttrs,
  type CriticChangeKind,
} from "../editor-extensions";
import {
  appendYamlEndmatter,
  collapseBlankLines,
  createMarkedRenderer,
  createTurndownService,
  decodeRawMarkdownPlaceholders,
  type MarkdownOptions,
  markedTokenizer,
  normalizeBlockSpacing,
  prependYamlFrontmatter,
  protectRichTextRoundTripMarkdown,
  splitYamlDocumentMetadata,
} from "../markdown";
import { chooseCodeFence } from "../markdown-fences";
import {
  collectEndmatterIds,
  type DeletedCommentRecord,
  type EndmatterEntry,
  type ParsedReviewEndmatter,
  parseReviewEndmatter,
  writeReviewEndmatter,
} from "../review-endmatter";
import {
  buildSourceSnapshot,
  type MarkdownSourceSnapshot,
  serializeWithSourceSnapshot,
} from "./source-snapshot";

/**
 * Where a comment's metadata lives in the file:
 * - `attributes`: inline `{id="c1" by="user" at="..."}` block;
 * - `reference`: inline `{#c1}` backed by a YAML endmatter entry;
 * - `legacy`: inline `{@id:c1; by:user; at:...@}` (migrated on save);
 * - `endmatter`: the whole comment lives in YAML endmatter (replies and
 *   document-level comments).
 * New comments leave it unset and follow the document's preferred format.
 */
export type CriticMetadataFormat =
  | "attributes"
  | "reference"
  | "legacy"
  | "endmatter";

export interface CriticComment {
  id: string;
  content: string;
  createdAt: string;
  authorType?: "user" | "ai";
  authorId?: string | null;
  parentCommentId?: string | null;
  scope?: "document";
  /** Review state. Roughdraft writes `resolved` when an item is addressed. */
  status?: string | null;
  /** Optional short resolution summary, written as `resolved`. */
  resolvedSummary?: string | null;
  metadataFormat?: CriticMetadataFormat;
  /** Unknown inline metadata attributes, preserved on write. */
  extraMetadata?: Record<string, string>;
}

export interface CriticCommentThread {
  comment: CriticComment;
  replies: CriticCommentThread[];
}

export type { CriticChangeAttrs, CriticChangeKind, DeletedCommentRecord };

type ChangeMetadataFormat = "attributes" | "reference";

/**
 * What the parser learned about the file, handed back to the serializer so a
 * save can preserve untouched content and keep every metadata format.
 */
export interface CriticDocumentSource {
  snapshot: MarkdownSourceSnapshot | null;
  /** Comments as they were when the file was read. */
  comments: Map<string, CriticComment>;
  changeFormats: Map<string, ChangeMetadataFormat>;
  /** Every review id that appears anywhere in the file. */
  reservedIds: string[];
  /** Endmatter entries the parser did not turn into comments or changes. */
  unmanagedCommentEntries: Array<[string, EndmatterEntry]>;
  unmanagedSuggestionEntries: Array<[string, EndmatterEntry]>;
}

interface CriticCommentToken {
  type: "criticCommentAnchor";
  raw: string;
  commentIds: string[];
  tokens: Token[];
}

interface CriticStandaloneCommentToken {
  type: "criticStandaloneComment";
  raw: string;
  commentIds: string[];
}

interface CriticChangeToken {
  type: "criticChange";
  raw: string;
  change: CriticChangeAttrs;
  commentIds: string[];
  tokens?: Token[];
  oldTokens?: Token[];
  newTokens?: Token[];
}

const extensions = createEditorExtensions("");
let cachedSchema: Schema | null = null;

function getEditorSchema(): Schema {
  cachedSchema ??= getSchema(extensions);
  return cachedSchema;
}

const criticCommentAnchorPattern = /^\{==([\s\S]+?)==\}/;
const criticCommentBlockPattern =
  /^\{>>([\s\S]*?)<<\}(?:(\{@([\s\S]+?)@\})|(\{(?:\s*[A-Za-z][A-Za-z0-9_-]*="(?:\\[\s\S]|[^"\\])*")+\s*\})|(\{#[A-Za-z][A-Za-z0-9_-]*\}))?/;
const criticAdditionPattern = /^\{\+\+([\s\S]+?)\+\+\}/;
const criticDeletionPattern = /^\{--([\s\S]+?)--\}/;
const criticSubstitutionPattern = /^\{~~([\s\S]+?)~>([\s\S]+?)~~\}/;
const attributeMetadataBlockPattern =
  /^\{(?:\s*[A-Za-z][A-Za-z0-9_-]*="(?:\\[\s\S]|[^"\\])*")+\s*\}/;
const metadataAttributePattern =
  /([A-Za-z][A-Za-z0-9_-]*)="((?:\\[\s\S]|[^"\\])*)"/g;
const metadataReferencePattern = /^\{#([A-Za-z][A-Za-z0-9_-]*)\}$/;
const criticDelimiterPattern =
  /\{>>|<<\}|\{==|==\}|\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}/;
const unanchoredCommentSentinel = "\u2060";
const knownMetadataAttributes = new Set(["id", "by", "at", "re", "status"]);
const INLINE_EXCERPT_LIMIT = 120;

interface ReviewEndmatterContext {
  parsed: ParsedReviewEndmatter;
  comments: Map<string, EndmatterEntry>;
  suggestions: Map<string, EndmatterEntry>;
}

function firstEntries(
  entries: Array<[string, EndmatterEntry]>,
): Map<string, EndmatterEntry> {
  const map = new Map<string, EndmatterEntry>();
  for (const [id, entry] of entries) {
    if (!map.has(id)) map.set(id, entry);
  }
  return map;
}

function createEndmatterContext(
  endmatter: string | null | undefined,
): ReviewEndmatterContext {
  const parsed = parseReviewEndmatter(endmatter);
  return {
    parsed,
    comments: firstEntries(parsed.commentEntries),
    suggestions: firstEntries(parsed.suggestionEntries),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function authorFields(author: string) {
  const isAi = author.toUpperCase() === "AI";
  return {
    authorType: isAi ? ("ai" as const) : ("user" as const),
    authorId: isAi ? null : author,
  };
}

function authorLabel(comment: Pick<CriticComment, "authorType" | "authorId">) {
  return comment.authorType === "ai" ? "AI" : comment.authorId || "user";
}

function commentPartialFromFields(
  fields: Map<string, string>,
  metadataFormat: CriticMetadataFormat,
): Partial<CriticComment> {
  const extraMetadata = Object.fromEntries(
    [...fields].filter(
      ([key]) => !knownMetadataAttributes.has(key) && key !== "resolved",
    ),
  );

  return {
    id: fields.get("id"),
    createdAt: fields.get("at") ?? new Date().toISOString(),
    ...authorFields(fields.get("by") ?? "user"),
    parentCommentId: fields.get("re") ?? null,
    metadataFormat,
    ...(fields.get("status") ? { status: fields.get("status") } : {}),
    ...(fields.get("resolved")
      ? { resolvedSummary: fields.get("resolved") }
      : {}),
    ...(Object.keys(extraMetadata).length > 0 ? { extraMetadata } : {}),
  };
}

function parseLegacyMetadata(metadataText?: string): Partial<CriticComment> {
  const fields = new Map<string, string>();

  for (const part of metadataText?.split(";") ?? []) {
    const [rawKey, ...valueParts] = part.split(":");
    const key = rawKey?.trim();
    const value = valueParts.join(":").trim();

    if (!key || !value) continue;
    fields.set(key, value);
  }

  return commentPartialFromFields(fields, "legacy");
}

function unescapeMetadataAttributeValue(value: string): string {
  return value.replaceAll(/\\([\s\S])/g, "$1");
}

function escapeMetadataAttributeValue(value: string): string {
  return value
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function parseAttributeFields(metadataText?: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (!metadataText?.startsWith("{") || !metadataText.endsWith("}")) {
    return fields;
  }

  for (const match of metadataText
    .slice(1, -1)
    .matchAll(metadataAttributePattern)) {
    fields.set(match[1] ?? "", unescapeMetadataAttributeValue(match[2] ?? ""));
  }

  return fields;
}

function commentPartialFromEndmatterEntry(
  id: string,
  entry: EndmatterEntry | undefined,
  options: { includeParent: boolean; metadataFormat: CriticMetadataFormat },
): Partial<CriticComment> {
  const status = typeof entry?.status === "string" ? entry.status : null;
  const resolvedSummary =
    typeof entry?.resolved === "string" ? entry.resolved : null;

  return {
    id,
    createdAt:
      typeof entry?.at === "string" ? entry.at : new Date().toISOString(),
    ...authorFields(typeof entry?.by === "string" ? entry.by : "user"),
    parentCommentId:
      options.includeParent && typeof entry?.re === "string" ? entry.re : null,
    metadataFormat: options.metadataFormat,
    ...(status ? { status } : {}),
    ...(resolvedSummary ? { resolvedSummary } : {}),
  };
}

/**
 * Comment metadata for an inline comment block. Returns the comment fields
 * and, for compact references whose endmatter entry stores the full text of a
 * long comment, that text.
 */
function parseCommentMetadata(
  legacyMetadataText: string | undefined,
  attributeMetadataText: string | undefined,
  referenceMetadataText: string | undefined,
  endmatter: ReviewEndmatterContext,
): { partial: Partial<CriticComment>; fullBody: string | null } {
  const reference = referenceMetadataText?.match(metadataReferencePattern);
  if (reference) {
    const id = reference[1] ?? "";
    const entry = endmatter.comments.get(id);
    // A root's endmatter `body` is the full text of a comment that could not
    // be written inline. An entry with `re` is stale reply metadata instead.
    const fullBody =
      typeof entry?.body === "string" && typeof entry.re !== "string"
        ? entry.body
        : null;
    return {
      partial: commentPartialFromEndmatterEntry(id, entry, {
        includeParent: false,
        metadataFormat: "reference",
      }),
      fullBody,
    };
  }

  if (attributeMetadataText) {
    return {
      partial: commentPartialFromFields(
        parseAttributeFields(attributeMetadataText),
        "attributes",
      ),
      fullBody: null,
    };
  }

  if (legacyMetadataText) {
    return { partial: parseLegacyMetadata(legacyMetadataText), fullBody: null };
  }

  return { partial: {}, fullBody: null };
}

function serializeAttributeMetadata(comment: CriticComment): string {
  const fields: Array<[string, string]> = [
    ["id", comment.id],
    ["by", authorLabel(comment)],
    ["at", comment.createdAt || new Date().toISOString()],
  ];

  if (comment.parentCommentId) fields.push(["re", comment.parentCommentId]);
  if (comment.status) fields.push(["status", comment.status]);
  if (comment.resolvedSummary) {
    fields.push(["resolved", comment.resolvedSummary]);
  }
  for (const [key, value] of Object.entries(comment.extraMetadata ?? {})) {
    if (knownMetadataAttributes.has(key) || key === "resolved") continue;
    fields.push([key, value]);
  }

  return `{${fields
    .map(([key, value]) => `${key}="${escapeMetadataAttributeValue(value)}"`)
    .join(" ")}}`;
}

function serializeChangeAttributeMetadata(change: CriticChangeAttrs): string {
  return serializeAttributeMetadata({
    id: change.changeId,
    content: "",
    createdAt: change.createdAt,
    authorType: change.authorType,
    authorId: change.authorId,
  });
}

/**
 * A comment body can be written inline only when it is a single line without
 * CriticMarkup delimiters. Anything else (pasted articles, lists, headings,
 * literal review syntax) would break the surrounding paragraph.
 */
export function isInlineSafeCommentBody(body: string): boolean {
  return !/[\r\n]/.test(body) && !criticDelimiterPattern.test(body);
}

function inlineCommentExcerpt(body: string): string {
  const firstLine =
    body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  let excerpt = firstLine
    .replace(new RegExp(criticDelimiterPattern.source, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();

  if (excerpt.length > INLINE_EXCERPT_LIMIT) {
    excerpt = excerpt.slice(0, INLINE_EXCERPT_LIMIT).trimEnd();
  }

  return excerpt ? `${excerpt} …` : "…";
}

export function createNextCommentId(
  existingComments: Iterable<Pick<CriticComment, "id">>,
): string {
  let maxId = 0;

  for (const comment of existingComments) {
    const match = comment.id.match(/^c(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `c${maxId + 1}`;
}

export function createNextChangeId(
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">>,
): string {
  let maxId = 0;

  for (const change of existingChanges) {
    const match = change.changeId.match(/^s(\d+)$/);
    if (!match) continue;

    const parsed = Number.parseInt(match[1] || "0", 10);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }

  return `s${maxId + 1}`;
}

function createCommentWithContext(
  partial?: Partial<CriticComment>,
  existingComments: Iterable<Pick<CriticComment, "id">> = [],
): CriticComment {
  const authorType = partial?.authorType ?? "user";
  const comment: CriticComment = {
    id: partial?.id ?? createNextCommentId(existingComments),
    content: partial?.content ?? "",
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
    parentCommentId: partial?.parentCommentId ?? null,
    scope: partial?.scope,
  };

  if (partial?.status) comment.status = partial.status;
  if (partial?.resolvedSummary) {
    comment.resolvedSummary = partial.resolvedSummary;
  }
  if (partial?.metadataFormat) comment.metadataFormat = partial.metadataFormat;
  if (partial?.extraMetadata) comment.extraMetadata = partial.extraMetadata;

  return comment;
}

function createChangeWithContext(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  existingChanges: Iterable<Pick<CriticChangeAttrs, "changeId">> = [],
): CriticChangeAttrs {
  const authorType = partial?.authorType ?? "user";

  return {
    kind,
    changeId: partial?.changeId ?? createNextChangeId(existingChanges),
    createdAt: partial?.createdAt ?? new Date().toISOString(),
    authorType,
    authorId: partial?.authorId ?? (authorType === "ai" ? null : "user"),
  };
}

function parseChangeMetadata(
  metadataText: string | undefined,
  endmatter: ReviewEndmatterContext,
): {
  partial: Partial<CriticChangeAttrs>;
  format: ChangeMetadataFormat | null;
} {
  const reference = metadataText?.match(metadataReferencePattern);
  if (reference) {
    const id = reference[1] ?? "";
    const parsed = commentPartialFromEndmatterEntry(
      id,
      endmatter.suggestions.get(id),
      { includeParent: false, metadataFormat: "reference" },
    );
    return {
      partial: {
        changeId: parsed.id,
        createdAt: parsed.createdAt,
        authorType: parsed.authorType,
        authorId: parsed.authorId,
      },
      format: "reference",
    };
  }

  if (!metadataText) return { partial: {}, format: null };

  const parsed = commentPartialFromFields(
    parseAttributeFields(metadataText),
    "attributes",
  );
  return {
    partial: {
      changeId: parsed.id,
      createdAt: parsed.createdAt,
      authorType: parsed.authorType,
      authorId: parsed.authorId,
    },
    format: "attributes",
  };
}

function buildCommentThreadsFromOrderedComments(
  orderedComments: CriticComment[],
): CriticCommentThread[] {
  const validCommentIds = new Set(orderedComments.map((comment) => comment.id));
  const repliesByParentId = new Map<string, CriticComment[]>();
  const rootComments: CriticComment[] = [];

  for (const comment of orderedComments) {
    const parentCommentId = comment.parentCommentId;

    if (
      !parentCommentId ||
      parentCommentId === comment.id ||
      !validCommentIds.has(parentCommentId)
    ) {
      rootComments.push(comment);
      continue;
    }

    const replies = repliesByParentId.get(parentCommentId) ?? [];
    replies.push(comment);
    repliesByParentId.set(parentCommentId, replies);
  }

  const buildNode = (comment: CriticComment): CriticCommentThread => ({
    comment,
    replies: (repliesByParentId.get(comment.id) ?? []).map(buildNode),
  });

  return rootComments.map(buildNode);
}

export function buildCommentThreads(
  comments: Iterable<CriticComment>,
): CriticCommentThread[] {
  return buildCommentThreadsFromOrderedComments([...comments]);
}

export function flattenCommentThreads(
  threads: Iterable<CriticCommentThread>,
): CriticComment[] {
  const orderedComments: CriticComment[] = [];

  const visit = (thread: CriticCommentThread) => {
    orderedComments.push(thread.comment);
    for (const reply of thread.replies) {
      visit(reply);
    }
  };

  for (const thread of threads) {
    visit(thread);
  }

  return orderedComments;
}

export function getCommentDescendantIds(
  commentId: string,
  comments: ReadonlyMap<string, CriticComment>,
): string[] {
  const childrenByParentId = new Map<string, string[]>();

  for (const comment of comments.values()) {
    if (!comment.parentCommentId || comment.parentCommentId === comment.id) {
      continue;
    }

    const childIds = childrenByParentId.get(comment.parentCommentId) ?? [];
    childIds.push(comment.id);
    childrenByParentId.set(comment.parentCommentId, childIds);
  }

  const descendantIds: string[] = [];
  const visited = new Set<string>([commentId]);
  const stack = [...(childrenByParentId.get(commentId) ?? [])].reverse();

  while (stack.length > 0) {
    const nextCommentId = stack.pop();
    if (!nextCommentId || visited.has(nextCommentId)) continue;

    visited.add(nextCommentId);
    descendantIds.push(nextCommentId);

    const childIds = childrenByParentId.get(nextCommentId) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) {
        stack.push(childId);
      }
    }
  }

  return descendantIds;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

interface CriticParseState {
  endmatter: ReviewEndmatterContext;
  comments: Map<string, CriticComment>;
  changes: Map<string, CriticChangeAttrs>;
  /** Every id that appears anywhere in the file. */
  reservedIds: Set<string>;
  /** Ids already given to a parsed comment or change. */
  usedIds: Set<string>;
  /**
   * Comment and change ids whose markdown must be rewritten on save:
   * synthesized metadata, legacy metadata, and repaired duplicate ids.
   */
  forcedIds: Set<string>;
  changeFormats: Map<string, ChangeMetadataFormat>;
}

interface CommentBlockContext {
  ids: string[];
  renames: Map<string, string>;
}

function collectReservedIds(
  body: string,
  endmatter: ReviewEndmatterContext,
): Set<string> {
  const ids = new Set(collectEndmatterIds(endmatter.parsed));
  for (const pattern of [
    /\bid="([A-Za-z][A-Za-z0-9_-]*)"/g,
    /\{#([A-Za-z][A-Za-z0-9_-]*)\}/g,
    /\{@[^@]*?\bid:\s*([A-Za-z][A-Za-z0-9_-]*)/g,
  ]) {
    for (const match of body.matchAll(pattern)) {
      if (match[1]) ids.add(match[1]);
    }
  }
  return ids;
}

function createParseState(
  body: string,
  endmatter: ReviewEndmatterContext,
): CriticParseState {
  return {
    endmatter,
    comments: new Map(),
    changes: new Map(),
    reservedIds: collectReservedIds(body, endmatter),
    usedIds: new Set(),
    forcedIds: new Set(),
    changeFormats: new Map(),
  };
}

function idsAsComments(ids: Iterable<string>) {
  return [...ids].map((id) => ({ id }));
}

function allocateCommentId(state: CriticParseState): string {
  const id = createNextCommentId(
    idsAsComments([...state.usedIds, ...state.reservedIds]),
  );
  state.usedIds.add(id);
  return id;
}

function allocateChangeId(state: CriticParseState): string {
  const id = createNextChangeId(
    [...state.usedIds, ...state.reservedIds].map((changeId) => ({ changeId })),
  );
  state.usedIds.add(id);
  return id;
}

function registerParsedComment(
  state: CriticParseState,
  partial: Partial<CriticComment>,
  content: string,
  block: CommentBlockContext,
): CriticComment {
  let parentCommentId = partial.parentCommentId ?? null;
  if (parentCommentId && block.renames.has(parentCommentId)) {
    parentCommentId = block.renames.get(parentCommentId) ?? parentCommentId;
  }

  const explicitId = partial.id;
  if (explicitId && !state.usedIds.has(explicitId)) {
    const comment = createCommentWithContext({
      ...partial,
      parentCommentId,
      content,
    });
    state.usedIds.add(comment.id);
    state.comments.set(comment.id, comment);
    if (partial.metadataFormat === "legacy") state.forcedIds.add(comment.id);
    block.ids.push(comment.id);
    return comment;
  }

  if (explicitId) {
    const existing = state.comments.get(explicitId);
    if (
      existing &&
      existing.content === content &&
      (existing.parentCommentId ?? null) === parentCommentId &&
      !block.ids.includes(explicitId)
    ) {
      // The same comment written on a second highlight (a selection that
      // spanned two blocks). Keep one comment; the save writes it once.
      state.forcedIds.add(explicitId);
      block.ids.push(explicitId);
      return existing;
    }
  }

  const id = allocateCommentId(state);
  if (explicitId) block.renames.set(explicitId, id);
  state.forcedIds.add(id);
  const comment = createCommentWithContext({
    ...partial,
    id,
    parentCommentId,
    content,
  });
  state.comments.set(id, comment);
  block.ids.push(id);
  return comment;
}

function registerParsedChange(
  state: CriticParseState,
  kind: CriticChangeKind,
  metadataText: string | undefined,
): CriticChangeAttrs {
  const { partial, format } = parseChangeMetadata(
    metadataText,
    state.endmatter,
  );
  const explicitId = partial.changeId;
  let changeId: string;

  if (explicitId && !state.usedIds.has(explicitId)) {
    changeId = explicitId;
    state.usedIds.add(changeId);
  } else {
    changeId = allocateChangeId(state);
    state.forcedIds.add(changeId);
  }

  if (format) state.changeFormats.set(changeId, format);
  const change = createChangeWithContext(kind, { ...partial, changeId });
  state.changes.set(changeId, change);
  return change;
}

function parseCommentBlockMatch(
  state: CriticParseState,
  match: RegExpMatchArray,
  block: CommentBlockContext,
): CriticComment {
  const [
    ,
    commentText,
    ,
    legacyMetadataText,
    attributeMetadataText,
    referenceMetadataText,
  ] = match;
  const { partial, fullBody } = parseCommentMetadata(
    legacyMetadataText,
    attributeMetadataText,
    referenceMetadataText,
    state.endmatter,
  );

  return registerParsedComment(
    state,
    partial,
    fullBody ?? commentText ?? "",
    block,
  );
}

function tokenizeCommentBlocks(
  state: CriticParseState,
  src: string,
  offset: number,
) {
  let raw = "";
  let nextOffset = offset;
  const block: CommentBlockContext = { ids: [], renames: new Map() };

  while (nextOffset < src.length) {
    const nextMatch = src.slice(nextOffset).match(criticCommentBlockPattern);
    if (!nextMatch) break;

    parseCommentBlockMatch(state, nextMatch, block);
    raw += nextMatch[0];
    nextOffset += nextMatch[0].length;
  }

  return { raw, commentIds: [...new Set(block.ids)] };
}

function tokenizeCriticCommentAnchor(
  state: CriticParseState,
  lexer: TokenizerThis["lexer"],
  src: string,
): CriticCommentToken | undefined {
  const anchorMatch = src.match(criticCommentAnchorPattern);
  if (!anchorMatch) return undefined;

  const [, anchor] = anchorMatch;
  const blocks = tokenizeCommentBlocks(state, src, anchorMatch[0].length);
  if (blocks.commentIds.length === 0) return undefined;

  return {
    type: "criticCommentAnchor",
    raw: anchorMatch[0] + blocks.raw,
    commentIds: blocks.commentIds,
    tokens: lexer.inlineTokens(anchor ?? ""),
  };
}

function getTrailingChangeMetadata(src: string, offset: number) {
  const reference = src.slice(offset).match(/^\{#[A-Za-z][A-Za-z0-9_-]*\}/);
  if (reference) {
    return { metadataText: reference[0], raw: reference[0] };
  }

  const match = src.slice(offset).match(attributeMetadataBlockPattern);
  return match
    ? { metadataText: match[0], raw: match[0] }
    : { metadataText: undefined, raw: "" };
}

function tokenizeCriticChange(
  state: CriticParseState,
  lexer: TokenizerThis["lexer"],
  src: string,
): CriticChangeToken | undefined {
  const additionMatch = src.match(criticAdditionPattern);
  const deletionMatch = additionMatch ? null : src.match(criticDeletionPattern);
  const substitutionMatch =
    additionMatch || deletionMatch
      ? null
      : src.match(criticSubstitutionPattern);
  const match = additionMatch ?? deletionMatch ?? substitutionMatch;
  if (!match) return undefined;

  const metadata = getTrailingChangeMetadata(src, match[0].length);
  const kind: CriticChangeKind = additionMatch
    ? "addition"
    : deletionMatch
      ? "deletion"
      : "substitution-old";
  const change = registerParsedChange(state, kind, metadata.metadataText);
  const trailingComments = tokenizeCommentBlocks(
    state,
    src,
    match[0].length + metadata.raw.length,
  );
  const raw = match[0] + metadata.raw + trailingComments.raw;

  if (substitutionMatch) {
    return {
      type: "criticChange",
      raw,
      change,
      commentIds: trailingComments.commentIds,
      oldTokens: lexer.inlineTokens(substitutionMatch[1] ?? ""),
      newTokens: lexer.inlineTokens(substitutionMatch[2] ?? ""),
    };
  }

  return {
    type: "criticChange",
    raw,
    change,
    commentIds: trailingComments.commentIds,
    tokens: lexer.inlineTokens(match[1] ?? ""),
  };
}

function renderCriticChangeSpan(
  change: CriticChangeAttrs,
  content: string,
  kind: CriticChangeKind = change.kind,
  commentIds: string[] = [],
) {
  const changeSpan = `<span data-critic-change-kind="${escapeHtml(kind)}" data-critic-change-id="${escapeHtml(
    change.changeId,
  )}" data-critic-change-by="${escapeHtml(authorLabel(change))}" data-critic-change-at="${escapeHtml(
    change.createdAt,
  )}">${content}</span>`;

  if (commentIds.length === 0) {
    return changeSpan;
  }

  return `<span data-comment-ids="${escapeHtml(
    JSON.stringify(commentIds),
  )}">${changeSpan}</span>`;
}

function renderCriticCodeText(state: CriticParseState, text: string) {
  let result = "";
  let offset = 0;

  while (offset < text.length) {
    const anchorMatch = text.slice(offset).match(criticCommentAnchorPattern);

    if (!anchorMatch) {
      result += escapeHtml(text[offset] ?? "");
      offset += 1;
      continue;
    }

    const [, anchor] = anchorMatch;
    const blocks = tokenizeCommentBlocks(
      state,
      text.slice(offset),
      anchorMatch[0].length,
    );

    if (blocks.commentIds.length === 0) {
      result += escapeHtml(anchorMatch[0]);
      offset += anchorMatch[0].length;
      continue;
    }

    result += `<span data-comment-ids="${escapeHtml(
      JSON.stringify(blocks.commentIds),
    )}">${escapeHtml(anchor ?? "")}</span>`;
    offset += anchorMatch[0].length + blocks.raw.length;
  }

  return result;
}

function codeFenceAttributes(token: Tokens.Code): string {
  if (token.codeBlockStyle === "indented") return "";

  const opening = token.raw.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)/);
  if (!opening) return "";

  const fence = opening[1] ?? "```";
  const info = (opening[2] ?? "").trim();
  return `${fence !== "```" ? ` data-fence="${escapeHtml(fence)}"` : ""}${
    info ? ` data-info="${escapeHtml(info)}"` : ""
  }`;
}

function renderCriticCodeBlock(state: CriticParseState, token: Tokens.Code) {
  const language = (token.lang || "").match(/\S+/)?.[0];
  const classAttr = language ? ` class="language-${escapeHtml(language)}"` : "";
  const content = token.escaped
    ? token.text
    : renderCriticCodeText(state, token.text);

  return `<pre${codeFenceAttributes(token)}><code${classAttr}>${content}</code></pre>\n`;
}

function createCriticMarked(
  state: CriticParseState,
  markdownOptions?: MarkdownOptions,
) {
  const renderer = createMarkedRenderer(markdownOptions);
  renderer.code = (token) => renderCriticCodeBlock(state, token);
  const parser = new Marked({
    gfm: true,
    async: false,
    renderer,
  });

  parser.use({
    tokenizer: markedTokenizer,
    extensions: [
      {
        name: "criticCommentAnchor",
        level: "inline",
        start(src: string) {
          return src.indexOf("{==");
        },
        tokenizer(this: TokenizerThis, src: string) {
          return tokenizeCriticCommentAnchor(state, this.lexer, src);
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticCommentToken;
          return `<span data-comment-ids="${escapeHtml(
            JSON.stringify(criticToken.commentIds),
          )}">${this.parser.parseInline(criticToken.tokens)}</span>`;
        },
        childTokens: ["tokens"],
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticStandaloneComment",
        level: "inline",
        start(src: string) {
          return src.indexOf("{>>");
        },
        tokenizer(src: string) {
          const result = tokenizeCommentBlocks(state, src, 0);
          if (result.commentIds.length === 0) return undefined;

          return {
            type: "criticStandaloneComment",
            raw: result.raw,
            commentIds: result.commentIds,
          } satisfies CriticStandaloneCommentToken;
        },
        renderer(token: Tokens.Generic) {
          const criticToken = token as CriticStandaloneCommentToken;
          return `<span data-comment-ids="${escapeHtml(
            JSON.stringify(criticToken.commentIds),
          )}" data-comment-anchorless="true">${unanchoredCommentSentinel}</span>`;
        },
      } satisfies TokenizerAndRendererExtension,
      {
        name: "criticChange",
        level: "inline",
        start(src: string) {
          const starts = ["{++", "{--", "{~~"]
            .map((marker) => src.indexOf(marker))
            .filter((index) => index >= 0);

          return starts.length > 0 ? Math.min(...starts) : undefined;
        },
        tokenizer(this: TokenizerThis, src: string) {
          return tokenizeCriticChange(state, this.lexer, src);
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const criticToken = token as CriticChangeToken;

          if (criticToken.change.kind === "substitution-old") {
            const oldContent = this.parser.parseInline(
              criticToken.oldTokens ?? [],
            );
            const newContent = this.parser.parseInline(
              criticToken.newTokens ?? [],
            );
            const substitutionHtml = `${renderCriticChangeSpan(
              criticToken.change,
              oldContent,
              "substitution-old",
            )}${renderCriticChangeSpan(
              criticToken.change,
              newContent,
              "substitution-new",
            )}`;

            if (criticToken.commentIds.length === 0) {
              return substitutionHtml;
            }

            return `<span data-comment-ids="${escapeHtml(
              JSON.stringify(criticToken.commentIds),
            )}">${substitutionHtml}</span>`;
          }

          return renderCriticChangeSpan(
            criticToken.change,
            this.parser.parseInline(criticToken.tokens ?? []),
            criticToken.change.kind,
            criticToken.commentIds,
          );
        },
        childTokens: ["tokens", "oldTokens", "newTokens"],
      } satisfies TokenizerAndRendererExtension,
    ],
  });

  return parser;
}

/**
 * Adds the comments that live only in YAML endmatter: replies (`re`) and
 * document-level comments. Ids already taken by an inline comment win; a
 * colliding reply is stale metadata and is dropped on save.
 */
function addEndmatterComments(state: CriticParseState) {
  for (const [id, entry] of state.endmatter.parsed.commentEntries) {
    if (typeof entry.body !== "string") continue;
    if (state.comments.has(id)) continue;

    const isReply = typeof entry.re === "string";
    let commentId = id;
    if (state.usedIds.has(id)) {
      commentId = allocateCommentId(state);
    } else {
      state.usedIds.add(id);
    }

    state.comments.set(
      commentId,
      createCommentWithContext({
        ...commentPartialFromEndmatterEntry(commentId, entry, {
          includeParent: true,
          metadataFormat: "endmatter",
        }),
        content: entry.body,
        parentCommentId: isReply ? String(entry.re) : null,
        scope: isReply ? undefined : "document",
      }),
    );
  }
}

interface ParsedCriticDocument {
  frontmatter: string | null;
  endmatter: string | null;
  rawBody: string;
  state: CriticParseState;
  parser: Marked;
  protectedBody: string;
}

function parseCriticDocument(
  markdown: string,
  options?: MarkdownOptions,
): ParsedCriticDocument {
  const { frontmatter, endmatter, rawBody } =
    splitYamlDocumentMetadata(markdown);
  const state = createParseState(rawBody, createEndmatterContext(endmatter));
  const parser = createCriticMarked(state, options);

  return {
    frontmatter,
    endmatter,
    rawBody,
    state,
    parser,
    protectedBody: protectRichTextRoundTripMarkdown(rawBody),
  };
}

export function criticMarkdownHasReviewRail(
  markdown: string,
  options?: MarkdownOptions,
): boolean {
  const parsed = parseCriticDocument(markdown, options);
  parsed.parser.parse(parsed.protectedBody);
  addEndmatterComments(parsed.state);
  return parsed.state.comments.size > 0 || parsed.state.changes.size > 0;
}

export function criticMarkdownToRenderedHtml(
  markdown: string,
  options?: MarkdownOptions,
): {
  html: string;
  comments: Map<string, CriticComment>;
  changes: Map<string, CriticChangeAttrs>;
  frontmatter: string | null;
  endmatter: string | null;
} {
  const parsed = parseCriticDocument(markdown, options);
  const html = parsed.parser.parse(parsed.protectedBody) as string;
  addEndmatterComments(parsed.state);

  return {
    html,
    comments: parsed.state.comments,
    changes: parsed.state.changes,
    frontmatter: parsed.frontmatter,
    endmatter: parsed.endmatter,
  };
}

function htmlToTopLevelNodes(html: string): JSONContent[] {
  if (!html.trim()) return [];

  const schema = getEditorSchema();
  const parsed = ProseMirrorDOMParser.fromSchema(schema)
    .parse(elementFromString(html))
    .toJSON() as JSONContent;
  const nodes = parsed.content ?? [];
  const isOnlyAnEmptyParagraph =
    nodes.length === 1 &&
    nodes[0]?.type === "paragraph" &&
    !nodes[0].content?.length;

  return isOnlyAnEmptyParagraph ? [] : nodes;
}

function collectNodeReviewIds(node: JSONContent): {
  commentIds: string[];
  changeIds: string[];
} {
  const commentIds = new Set<string>();
  const changeIds = new Set<string>();
  const visit = (current: JSONContent) => {
    for (const mark of current.marks ?? []) {
      if (mark.type === "commentRef" && Array.isArray(mark.attrs?.commentIds)) {
        for (const id of mark.attrs.commentIds as unknown[]) {
          if (typeof id === "string") commentIds.add(id);
        }
      }
      if (
        mark.type === "criticChange" &&
        typeof mark.attrs?.changeId === "string"
      ) {
        changeIds.add(mark.attrs.changeId);
      }
    }
    for (const child of current.content ?? []) visit(child);
  };

  visit(node);
  return { commentIds: [...commentIds], changeIds: [...changeIds] };
}

function commentDigest(comment: CriticComment | undefined): string {
  if (!comment) return "missing";
  return JSON.stringify([
    comment.id,
    comment.content,
    comment.createdAt,
    comment.authorType,
    comment.authorId,
    comment.parentCommentId ?? null,
    comment.scope ?? null,
    comment.status ?? null,
    comment.resolvedSummary ?? null,
    comment.metadataFormat ?? null,
    comment.extraMetadata ?? null,
  ]);
}

/**
 * Identity of a top-level node for change detection: its JSON plus the data
 * of every comment it anchors, because editing or resolving a comment changes
 * the markdown without changing the editor document.
 */
function nodeMatchKey(
  node: JSONContent,
  comments: ReadonlyMap<string, CriticComment>,
): string {
  const { commentIds } = collectNodeReviewIds(node);
  const digests = [...commentIds]
    .sort()
    .map((id) => commentDigest(comments.get(id)));
  return `${JSON.stringify(node)}\u0000${digests.join("\u0000")}`;
}

export function criticMarkdownToEditorState(
  markdown: string,
  options?: MarkdownOptions,
): {
  doc: JSONContent;
  comments: Map<string, CriticComment>;
  frontmatter: string | null;
  endmatter: string | null;
  source: CriticDocumentSource;
  reservedIds: string[];
} {
  const parsed = parseCriticDocument(markdown, options);
  const tokens = parsed.parser.lexer(parsed.protectedBody);
  const tokenInputs = tokens.map((token) => {
    const html = parsed.parser.parser([token]) as string;
    return { raw: token.raw, nodes: htmlToTopLevelNodes(html) };
  });
  addEndmatterComments(parsed.state);

  const nodes = tokenInputs.flatMap((token) => token.nodes);
  const state = parsed.state;
  const snapshot = buildSourceSnapshot({
    lexedBody: parsed.protectedBody,
    originalBody: parsed.rawBody,
    tokens: tokenInputs,
    decode: decodeRawMarkdownPlaceholders,
    nodeKey: (node) => nodeMatchKey(node, state.comments),
    forcedNodes: (node) => {
      const ids = collectNodeReviewIds(node);
      return [...ids.commentIds, ...ids.changeIds].some((id) =>
        state.forcedIds.has(id),
      );
    },
  });

  const consumedCommentIds = new Set(state.comments.keys());
  const consumedChangeIds = new Set(state.changes.keys());
  const source: CriticDocumentSource = {
    snapshot,
    comments: new Map(state.comments),
    changeFormats: new Map(state.changeFormats),
    reservedIds: [...new Set([...state.reservedIds, ...state.usedIds])],
    unmanagedCommentEntries: state.endmatter.parsed.commentEntries.filter(
      ([id]) => !consumedCommentIds.has(id),
    ),
    unmanagedSuggestionEntries: state.endmatter.parsed.suggestionEntries.filter(
      ([id]) => !consumedChangeIds.has(id),
    ),
  };

  const doc = {
    type: "doc",
    content: nodes.length > 0 ? nodes : [{ type: "paragraph" }],
  } as JSONContent & {
    yamlFrontmatter?: string;
    yamlEndmatter?: string;
    roughdraftSource?: CriticDocumentSource;
  };
  if (parsed.frontmatter) {
    doc.yamlFrontmatter = parsed.frontmatter;
  }
  if (parsed.endmatter) {
    doc.yamlEndmatter = parsed.endmatter;
  }
  doc.roughdraftSource = source;

  return {
    doc,
    comments: state.comments,
    frontmatter: parsed.frontmatter,
    endmatter: parsed.endmatter,
    source,
    reservedIds: source.reservedIds,
  };
}

/* -------------------------------------------------------------------------- */
/* Serializing                                                                */
/* -------------------------------------------------------------------------- */

type MetadataPreference = "attributes" | "reference";

interface CriticSerializeContext {
  comments: ReadonlyMap<string, CriticComment>;
  preferredFormat: MetadataPreference;
  changeFormats: ReadonlyMap<string, ChangeMetadataFormat>;
  emittedCommentIds: Set<string>;
  /** Change ids written so far, with the attributes they were written with. */
  emittedChanges: Map<string, CriticChangeAttrs>;
  /** For ids given to later parts of a split change: the original id. */
  changeIdOrigins: Map<string, string>;
  knownChangeIds: Set<string>;
}

type CommentPlacement = "attributes" | "reference" | "endmatter";

function commentPlacement(
  comment: CriticComment,
  preferredFormat: MetadataPreference,
): CommentPlacement {
  if (comment.scope === "document") return "endmatter";

  const inlineSafe = isInlineSafeCommentBody(comment.content);
  const format = comment.metadataFormat;

  if (comment.parentCommentId) {
    if ((format === "attributes" || format === "legacy") && inlineSafe) {
      return "attributes";
    }
    if (
      format === undefined &&
      preferredFormat === "attributes" &&
      inlineSafe
    ) {
      return "attributes";
    }
    return "endmatter";
  }

  if (format === "reference" || format === "endmatter") return "reference";
  if (format === "attributes" || format === "legacy") {
    return inlineSafe ? "attributes" : "reference";
  }
  return preferredFormat === "attributes" && inlineSafe
    ? "attributes"
    : "reference";
}

function serializeCommentBlocks(
  commentIds: string[],
  context: CriticSerializeContext,
): string {
  const visibleComments = commentIds
    .map((commentId) => context.comments.get(commentId))
    .filter(
      (comment): comment is CriticComment =>
        comment !== undefined &&
        comment.scope !== "document" &&
        comment.content.trim().length > 0 &&
        !context.emittedCommentIds.has(comment.id),
    );
  let result = "";

  for (const comment of flattenCommentThreads(
    buildCommentThreads(visibleComments),
  )) {
    const placement = commentPlacement(comment, context.preferredFormat);
    if (placement === "endmatter") continue;

    context.emittedCommentIds.add(comment.id);
    result +=
      placement === "attributes"
        ? `{>>${comment.content}<<}${serializeAttributeMetadata(comment)}`
        : `{>>${
            isInlineSafeCommentBody(comment.content)
              ? comment.content
              : inlineCommentExcerpt(comment.content)
          }<<}{#${comment.id}}`;
  }

  return result;
}

function getElementCommentIds(element: HTMLElement): string[] {
  const commentIdsText = element.getAttribute("data-comment-ids");
  if (!commentIdsText) return [];

  try {
    const parsed = JSON.parse(commentIdsText) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function getElementChangeAttrs(element: HTMLElement): CriticChangeAttrs | null {
  const kind = element.getAttribute("data-critic-change-kind");
  const changeId = element.getAttribute("data-critic-change-id");
  const createdAt = element.getAttribute("data-critic-change-at");

  if (
    kind !== "addition" &&
    kind !== "deletion" &&
    kind !== "substitution-old" &&
    kind !== "substitution-new"
  ) {
    return null;
  }

  if (!changeId || !createdAt) return null;

  return {
    kind,
    changeId,
    createdAt,
    ...authorFields(element.getAttribute("data-critic-change-by") || "user"),
  };
}

function isPairedSubstitutionElement(
  element: Element | null,
  kind: CriticChangeKind,
  changeId: string,
) {
  return (
    element instanceof HTMLElement &&
    element.getAttribute("data-critic-change-kind") === kind &&
    element.getAttribute("data-critic-change-id") === changeId
  );
}

/**
 * Picks the id a change is written with. A change whose marks were split
 * across blocks would otherwise write the same id twice; later parts get
 * their own ids.
 */
function claimChangeId(
  change: CriticChangeAttrs,
  context: CriticSerializeContext,
): CriticChangeAttrs {
  if (!context.emittedChanges.has(change.changeId)) {
    context.emittedChanges.set(change.changeId, change);
    return change;
  }

  const changeId = createNextChangeId(
    [...context.knownChangeIds, ...context.emittedChanges.keys()].map((id) => ({
      changeId: id,
    })),
  );
  const claimed = { ...change, changeId };
  context.knownChangeIds.add(changeId);
  context.emittedChanges.set(changeId, claimed);
  context.changeIdOrigins.set(changeId, change.changeId);
  return claimed;
}

function changeMetadata(
  change: CriticChangeAttrs,
  originalChangeId: string,
  context: CriticSerializeContext,
): string {
  const format =
    context.changeFormats.get(originalChangeId) ?? context.preferredFormat;
  return format === "reference"
    ? `{#${change.changeId}}`
    : serializeChangeAttributeMetadata(change);
}

function serializeCriticChangeElement(
  service: TurndownService,
  element: HTMLElement,
  content: string,
  context: CriticSerializeContext,
  extraCommentIds: string[] = [],
) {
  const change = getElementChangeAttrs(element);
  if (!change) return content;

  if (
    change.kind === "substitution-new" &&
    isPairedSubstitutionElement(
      element.previousElementSibling,
      "substitution-old",
      change.changeId,
    )
  ) {
    return "";
  }

  const commentBlocks = serializeCommentBlocks(
    [...new Set([...getElementCommentIds(element), ...extraCommentIds])],
    context,
  );
  const nextElement = element.nextElementSibling;
  const pairedReplacement =
    change.kind === "substitution-old" &&
    nextElement instanceof HTMLElement &&
    isPairedSubstitutionElement(
      nextElement,
      "substitution-new",
      change.changeId,
    )
      ? service.turndown(nextElement.innerHTML).trim()
      : null;
  const writtenKind =
    change.kind === "substitution-new"
      ? "addition"
      : change.kind === "substitution-old" && pairedReplacement === null
        ? "deletion"
        : change.kind;
  const claimed = claimChangeId({ ...change, kind: writtenKind }, context);
  const metadata = changeMetadata(claimed, change.changeId, context);

  if (writtenKind === "addition") {
    return `{++${content}++}${metadata}${commentBlocks}`;
  }

  if (writtenKind === "deletion") {
    return `{--${content}--}${metadata}${commentBlocks}`;
  }

  return `{~~${content}~>${pairedReplacement ?? ""}~~}${metadata}${commentBlocks}`;
}

function serializeCodeElementContent(
  node: Node,
  context: CriticSerializeContext,
): string {
  let result = "";

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      result += child.nodeValue ?? "";
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    if (child.nodeName === "BR") {
      result += "\n";
      continue;
    }

    const inner = serializeCodeElementContent(child, context);
    if (child.hasAttribute("data-comment-ids")) {
      const commentBlocks = serializeCommentBlocks(
        getElementCommentIds(child),
        context,
      );
      result += commentBlocks ? `{==${inner}==}${commentBlocks}` : inner;
      continue;
    }

    result += inner;
  }

  return result;
}

function createCriticTurndownService(contextRef: {
  current: CriticSerializeContext;
}): TurndownService {
  const service = createTurndownService();

  // Turndown converts children before their parent, and these rules record
  // which ids were written. Elements that a parent rule serializes itself
  // (code blocks, changes wrapped in a comment highlight) are skipped here so
  // nothing is written twice.
  service.addRule("criticComment", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute("data-comment-ids") &&
      !(node as HTMLElement).closest("pre"),
    replacement(content, node) {
      const element = node as HTMLElement;
      const commentIds = getElementCommentIds(element);
      const criticChangeElement = element.querySelector(
        "span[data-critic-change-kind]",
      );
      if (criticChangeElement instanceof HTMLElement) {
        return serializeCriticChangeElement(
          service,
          criticChangeElement,
          service.turndown(criticChangeElement.innerHTML).trim(),
          contextRef.current,
          commentIds,
        );
      }

      const commentBlocks = serializeCommentBlocks(
        commentIds,
        contextRef.current,
      );
      if (content === unanchoredCommentSentinel) return commentBlocks;
      if (!commentBlocks) return content;

      return `{==${content}==}${commentBlocks}`;
    },
  });

  service.addRule("criticChange", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as HTMLElement).hasAttribute("data-critic-change-kind") &&
      !(node as HTMLElement).closest("pre") &&
      !(node as HTMLElement).parentElement?.hasAttribute("data-comment-ids"),
    replacement(content, node) {
      return serializeCriticChangeElement(
        service,
        node as HTMLElement,
        content,
        contextRef.current,
      );
    },
  });

  service.addRule("roughdraftCodeBlock", {
    filter: (node) =>
      node.nodeName === "PRE" &&
      (node as HTMLElement).firstElementChild?.nodeName === "CODE",
    replacement(_content, node) {
      const pre = node as HTMLElement;
      const code = pre.firstElementChild as HTMLElement;
      const language =
        [...code.classList]
          .find((className) => className.startsWith("language-"))
          ?.slice("language-".length) ?? "";
      const storedInfo = pre.getAttribute("data-info") ?? "";
      const info =
        storedInfo && storedInfo.split(/\s+/)[0] === language
          ? storedInfo
          : language;
      const body = serializeCodeElementContent(
        code,
        contextRef.current,
      ).replace(/\n$/, "");
      const fence = chooseCodeFence(body, pre.getAttribute("data-fence"));

      return `\n\n${fence}${info}\n${body}\n${fence}\n\n`;
    },
  });

  return service;
}

function collectCriticChangesFromDoc(
  doc: JSONContent,
): Map<string, CriticChangeAttrs> {
  const changes = new Map<string, CriticChangeAttrs>();
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== "criticChange") continue;

      const attrs = mark.attrs as Partial<CriticChangeAttrs> | undefined;
      if (
        attrs?.changeId &&
        attrs.kind &&
        attrs.createdAt &&
        attrs.authorType
      ) {
        changes.set(attrs.changeId, {
          kind: attrs.kind,
          changeId: attrs.changeId,
          createdAt: attrs.createdAt,
          authorType: attrs.authorType,
          authorId: attrs.authorId ?? null,
        });
      }
    }

    for (const child of node.content ?? []) {
      visit(child);
    }
  };

  visit(doc);
  return changes;
}

function endmatterCommentEntries(
  comments: ReadonlyMap<string, CriticComment>,
  preferredFormat: MetadataPreference,
): Map<string, EndmatterEntry> {
  const entries = new Map<string, EndmatterEntry>();

  for (const comment of comments.values()) {
    if (!comment.content.trim()) continue;

    const placement = commentPlacement(comment, preferredFormat);
    if (placement === "attributes") continue;

    const common = {
      by: authorLabel(comment),
      at: comment.createdAt,
      status: comment.status || undefined,
      resolved: comment.resolvedSummary || undefined,
    };

    if (comment.scope === "document") {
      entries.set(comment.id, { body: comment.content, ...common });
    } else if (comment.parentCommentId) {
      entries.set(comment.id, {
        body: comment.content,
        ...common,
        re: comment.parentCommentId,
      });
    } else {
      entries.set(comment.id, {
        body: isInlineSafeCommentBody(comment.content)
          ? undefined
          : comment.content,
        ...common,
      });
    }
  }

  return entries;
}

function managedFieldsOf(entry: EndmatterEntry): EndmatterEntry {
  const fields: EndmatterEntry = {};
  for (const key of ["body", "by", "at", "re", "status", "resolved"]) {
    if (key in entry) fields[key] = entry[key];
  }
  return fields;
}

export interface CriticSerializeOptions {
  frontmatter?: string | null;
  endmatter?: string | null;
  /** What the parser learned about the file; defaults to `doc.roughdraftSource`. */
  source?: CriticDocumentSource | null;
  /** Deleted comments to record in the endmatter `deleted` list. */
  deletedComments?: DeletedCommentRecord[];
}

export function editorStateToCriticMarkdown(
  doc: JSONContent,
  comments: Map<string, CriticComment>,
  options?: CriticSerializeOptions,
): string {
  const docExtras = doc as JSONContent & {
    yamlFrontmatter?: string;
    yamlEndmatter?: string;
    roughdraftSource?: CriticDocumentSource;
  };
  const frontmatter = options?.frontmatter ?? docExtras.yamlFrontmatter ?? null;
  const sourceEndmatter = options?.endmatter ?? docExtras.yamlEndmatter ?? null;
  const source = options?.source ?? docExtras.roughdraftSource ?? null;
  const changes = collectCriticChangesFromDoc(doc);
  const preferredFormat: MetadataPreference = sourceEndmatter
    ? "reference"
    : "attributes";
  const knownChangeIds = new Set([
    ...changes.keys(),
    ...(source?.reservedIds ?? []),
  ]);
  const createContext = (
    commentMap: ReadonlyMap<string, CriticComment>,
  ): CriticSerializeContext => ({
    comments: commentMap,
    preferredFormat,
    changeFormats: source?.changeFormats ?? new Map(),
    emittedCommentIds: new Set(),
    emittedChanges: new Map(),
    changeIdOrigins: new Map(),
    knownChangeIds: new Set(knownChangeIds),
  });
  const mainContext = createContext(comments);
  const contextRef = { current: mainContext };
  const service = createCriticTurndownService(contextRef);
  const schema = getEditorSchema();

  const serializeNodeWith = (
    node: JSONContent,
    context: CriticSerializeContext,
  ): string => {
    const previous = contextRef.current;
    contextRef.current = context;
    try {
      const html = getHTMLFromFragment(
        Fragment.from(ProseMirrorNode.fromJSON(schema, node)),
        schema,
      );
      return collapseBlankLines(service.turndown(html)).trim();
    } finally {
      contextRef.current = previous;
    }
  };

  let body: string;
  const snapshot = source?.snapshot ?? null;
  if (snapshot) {
    const canonicalOriginals = new Map<number, string>();
    body = serializeWithSourceSnapshot({
      snapshot,
      nodes: doc.content ?? [],
      nodeKey: (node) => nodeMatchKey(node, comments),
      sameContent: (originalIndex, node) => {
        const originalNode = snapshot.nodes[originalIndex];
        if (!originalNode) return false;
        if (!canonicalOriginals.has(originalIndex)) {
          canonicalOriginals.set(
            originalIndex,
            serializeNodeWith(
              originalNode,
              createContext(source?.comments ?? comments),
            ),
          );
        }
        return (
          canonicalOriginals.get(originalIndex) ===
          serializeNodeWith(node, createContext(comments))
        );
      },
      serializeNode: (node) => serializeNodeWith(node, mainContext),
      onUntouchedNode: (node) => {
        const ids = collectNodeReviewIds(node);
        for (const id of ids.commentIds) mainContext.emittedCommentIds.add(id);
        for (const id of ids.changeIds) {
          const change = changes.get(id);
          if (change) mainContext.emittedChanges.set(id, change);
        }
      },
    });
  } else {
    const html = getHTMLFromFragment(
      ProseMirrorNode.fromJSON(schema, doc).content,
      schema,
    );
    body = normalizeBlockSpacing(`${service.turndown(html).trimEnd()}\n`);
  }

  const suggestionEntries = new Map<string, EndmatterEntry>();
  for (const [changeId, change] of mainContext.emittedChanges) {
    const originalId = mainContext.changeIdOrigins.get(changeId) ?? changeId;
    const format = source?.changeFormats.get(originalId) ?? preferredFormat;
    if (format !== "reference") continue;
    suggestionEntries.set(changeId, {
      by: authorLabel(change),
      at: change.createdAt,
    });
  }

  const commentEntries = endmatterCommentEntries(comments, preferredFormat);
  const knownCommentIds = new Set(comments.keys());
  for (const [id, entry] of source?.unmanagedCommentEntries ?? []) {
    if (knownCommentIds.has(id) || commentEntries.has(id)) continue;
    commentEntries.set(id, managedFieldsOf(entry));
  }
  for (const [id, entry] of source?.unmanagedSuggestionEntries ?? []) {
    if (changes.has(id) || suggestionEntries.has(id)) continue;
    suggestionEntries.set(id, managedFieldsOf(entry));
  }

  const endmatter = writeReviewEndmatter(sourceEndmatter, {
    comments: commentEntries,
    suggestions: suggestionEntries,
    appendDeleted: options?.deletedComments ?? [],
  });

  let markdown: string;
  if (snapshot) {
    if (endmatter && sourceEndmatter) {
      markdown = `${body}\n${endmatter}`;
    } else if (endmatter) {
      markdown = appendYamlEndmatter(body, endmatter);
    } else {
      markdown = body.endsWith("\n") || body === "" ? body : `${body}\n`;
    }
  } else {
    markdown = appendYamlEndmatter(body, endmatter);
  }

  return prependYamlFrontmatter(markdown, frontmatter);
}

export function createCriticComment(
  partial?: Partial<CriticComment>,
  options?: {
    existingComments?: Iterable<Pick<CriticComment, "id">>;
    /** Ids used anywhere in the file (see `criticMarkdownToEditorState`). */
    reservedIds?: Iterable<string>;
  },
): CriticComment {
  return createCommentWithContext(partial, [
    ...(options?.existingComments ?? []),
    ...idsAsComments(options?.reservedIds ?? []),
  ]);
}

export function createCriticChange(
  kind: CriticChangeKind,
  partial?: Partial<CriticChangeAttrs>,
  options?: {
    existingChanges?: Iterable<Pick<CriticChangeAttrs, "changeId">>;
    reservedIds?: Iterable<string>;
  },
): CriticChangeAttrs {
  return createChangeWithContext(kind, partial, [
    ...(options?.existingChanges ?? []),
    ...[...(options?.reservedIds ?? [])].map((changeId) => ({ changeId })),
  ]);
}

/**
 * Builds the record kept in the endmatter `deleted` list when a comment is
 * deleted.
 */
export function createDeletedCommentRecord(
  comment: CriticComment,
  options?: { deletedAt?: string; anchor?: string | null },
): DeletedCommentRecord {
  return {
    id: comment.id,
    by: authorLabel(comment),
    at: comment.createdAt,
    deletedAt: options?.deletedAt ?? new Date().toISOString(),
    ...(comment.parentCommentId ? { re: comment.parentCommentId } : {}),
    ...(options?.anchor ? { anchor: options.anchor } : {}),
    body: comment.content,
  };
}
