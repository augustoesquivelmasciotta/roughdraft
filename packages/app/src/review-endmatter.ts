import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

/**
 * Review metadata stored in the final YAML endmatter of a Roughdraft document.
 *
 * Reading keeps every entry in file order (duplicate ids included) so the
 * parser can repair files that were written with colliding ids. Writing edits
 * the YAML document in place, so entries nobody touched keep their quoting,
 * order and comments.
 */

export type EndmatterEntry = Record<string, unknown>;

export interface DeletedCommentRecord {
  id: string;
  by: string;
  at?: string;
  deletedAt: string;
  body: string;
  re?: string;
  anchor?: string;
}

export interface ParsedReviewEndmatter {
  /** Comment entries in file order. Duplicate ids are kept. */
  commentEntries: Array<[string, EndmatterEntry]>;
  /** Suggestion entries in file order. Duplicate ids are kept. */
  suggestionEntries: Array<[string, EndmatterEntry]>;
  /** Valid records from the optional top-level `deleted` list. */
  deleted: DeletedCommentRecord[];
  data: Record<string, unknown> | null;
}

const isoDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isoDateTimePattern.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stripEndmatterDelimiter(endmatter: string): string {
  return endmatter.replace(/^---[ \t]*(?:\r\n|\n)/, "");
}

function parseEndmatterDocument(endmatter: string): Document | null {
  const document = parseDocument(stripEndmatterDelimiter(endmatter), {
    uniqueKeys: false,
  });
  if (document.errors.length > 0) return null;
  return document;
}

function keyToString(key: unknown): string {
  if (isScalar(key)) return String(key.value);
  return String(key);
}

function readEntryPairs(
  document: Document,
  key: string,
): Array<[string, EndmatterEntry]> {
  const node = document.get(key, true);
  if (!isMap(node)) return [];

  const entries: Array<[string, EndmatterEntry]> = [];
  for (const pair of node.items) {
    if (!isMap(pair.value)) continue;
    const value = pair.value.toJSON() as unknown;
    if (!isPlainObject(value)) continue;
    entries.push([keyToString(pair.key), value]);
  }

  return entries;
}

function toDeletedRecord(value: unknown): DeletedCommentRecord | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.deletedAt !== "string") return null;

  return {
    id: value.id,
    by: typeof value.by === "string" ? value.by : "user",
    ...(typeof value.at === "string" ? { at: value.at } : {}),
    deletedAt: value.deletedAt,
    body: typeof value.body === "string" ? value.body : "",
    ...(typeof value.re === "string" ? { re: value.re } : {}),
    ...(typeof value.anchor === "string" ? { anchor: value.anchor } : {}),
  };
}

const emptyParsedEndmatter: ParsedReviewEndmatter = {
  commentEntries: [],
  suggestionEntries: [],
  deleted: [],
  data: null,
};

export function parseReviewEndmatter(
  endmatter: string | null | undefined,
): ParsedReviewEndmatter {
  if (!endmatter) return emptyParsedEndmatter;

  const document = parseEndmatterDocument(endmatter);
  if (!document) return emptyParsedEndmatter;

  const data = document.toJS() as unknown;
  if (!isPlainObject(data)) return emptyParsedEndmatter;

  const deleted = Array.isArray(data.deleted)
    ? data.deleted
        .map(toDeletedRecord)
        .filter((record): record is DeletedCommentRecord => Boolean(record))
    : [];

  return {
    commentEntries: readEntryPairs(document, "comments"),
    suggestionEntries: readEntryPairs(document, "suggestions"),
    deleted,
    data,
  };
}

/**
 * Decides whether a final YAML block is Roughdraft review endmatter rather
 * than ordinary document text after a thematic break. It must have review
 * maps, and some evidence that they belong to Roughdraft: a `{#id}` reference
 * in the body, a document-level comment, a reply entry with a valid
 * timestamp (replies may point at comments that use inline attribute
 * metadata), or a record of a deleted comment.
 */
export function isReviewEndmatter(
  parsed: ParsedReviewEndmatter,
  precedingBody: string,
): boolean {
  const data = parsed.data;
  if (!data) return false;

  const hasReviewMaps =
    isPlainObject(data.comments) ||
    isPlainObject(data.suggestions) ||
    Array.isArray(data.deleted);
  if (!hasReviewMaps) return false;

  if (/\{#[A-Za-z][A-Za-z0-9_-]*\}/.test(precedingBody)) return true;

  for (const [, entry] of parsed.commentEntries) {
    if (typeof entry.body !== "string" || typeof entry.by !== "string") {
      continue;
    }
    if (typeof entry.re !== "string" && typeof entry.at === "string") {
      return true;
    }
    if (typeof entry.re === "string" && isIsoDateTime(entry.at)) {
      return true;
    }
  }

  return parsed.deleted.length > 0;
}

export function collectEndmatterIds(parsed: ParsedReviewEndmatter): string[] {
  return [
    ...parsed.commentEntries.map(([id]) => id),
    ...parsed.suggestionEntries.map(([id]) => id),
    ...parsed.deleted.map((record) => record.id),
  ];
}

export interface ReviewEndmatterUpdate {
  /** Desired managed fields for every comment entry that must exist. */
  comments: Map<string, EndmatterEntry>;
  /** Desired managed fields for every suggestion entry that must exist. */
  suggestions: Map<string, EndmatterEntry>;
  /** Deleted-comment records to append to the `deleted` list. */
  appendDeleted?: DeletedCommentRecord[];
}

const commentEntryKeyOrder = ["body", "by", "at", "re", "status", "resolved"];
const suggestionEntryKeyOrder = ["by", "at", "status", "resolved"];
const deletedRecordKeyOrder = [
  "id",
  "by",
  "at",
  "deletedAt",
  "re",
  "anchor",
  "body",
];

function createValueNode(document: Document, value: unknown) {
  if (typeof value === "string" && /[\r\n]/.test(value)) {
    const scalar = new Scalar(value);
    scalar.type = Scalar.BLOCK_LITERAL;
    return scalar;
  }

  return document.createNode(value);
}

function createOrderedMap(
  document: Document,
  fields: EndmatterEntry,
  keyOrder: string[],
): YAMLMap {
  const map = document.createNode({}) as YAMLMap;
  const keys = [
    ...keyOrder.filter((key) => key in fields),
    ...Object.keys(fields).filter((key) => !keyOrder.includes(key)),
  ];

  for (const key of keys) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    map.set(key, createValueNode(document, value));
  }

  return map;
}

function syncEntryMap(
  document: Document,
  key: string,
  desired: Map<string, EndmatterEntry>,
  managedKeys: string[],
): boolean {
  const current = document.get(key, true);

  if (desired.size === 0) {
    if (current === undefined) return false;
    document.delete(key);
    return true;
  }

  let changed = false;
  let map: YAMLMap;
  if (isMap(current)) {
    map = current;
  } else {
    map = document.createNode({}) as YAMLMap;
    document.set(key, map);
    changed = true;
  }

  const seen = new Set<string>();
  for (const pair of [...map.items]) {
    const id = keyToString(pair.key);
    const fields = desired.get(id);

    if (!fields || seen.has(id)) {
      map.items.splice(map.items.indexOf(pair), 1);
      changed = true;
      continue;
    }

    seen.add(id);
    if (!isMap(pair.value)) {
      pair.value = createOrderedMap(document, fields, managedKeys);
      changed = true;
      continue;
    }

    const entry = pair.value;
    for (const fieldKey of managedKeys) {
      const value = fields[fieldKey];
      if (value === undefined || value === null) {
        if (entry.has(fieldKey)) {
          entry.delete(fieldKey);
          changed = true;
        }
        continue;
      }

      if (entry.get(fieldKey) !== value) {
        entry.set(fieldKey, createValueNode(document, value));
        changed = true;
      }
    }
  }

  for (const [id, fields] of desired) {
    if (seen.has(id)) continue;
    map.set(id, createOrderedMap(document, fields, managedKeys));
    changed = true;
  }

  return changed;
}

function appendDeletedRecords(
  document: Document,
  records: DeletedCommentRecord[],
): boolean {
  if (records.length === 0) return false;

  let sequence = document.get("deleted", true);
  if (!isSeq(sequence)) {
    sequence = document.createNode([]) as YAMLSeq;
    document.set("deleted", sequence);
  }

  for (const record of records) {
    (sequence as YAMLSeq).add(
      createOrderedMap(
        document,
        record as unknown as EndmatterEntry,
        deletedRecordKeyOrder,
      ),
    );
  }

  return true;
}

/**
 * Writes review metadata into an endmatter block. Returns the original text
 * unchanged when the requested metadata already matches it, `null` when no
 * endmatter is needed, or the updated `---`-prefixed YAML otherwise.
 */
export function writeReviewEndmatter(
  existingEndmatter: string | null | undefined,
  update: ReviewEndmatterUpdate,
): string | null {
  const parsedDocument = existingEndmatter
    ? parseEndmatterDocument(existingEndmatter)
    : null;
  const document =
    parsedDocument && isMap(parsedDocument.contents)
      ? parsedDocument
      : parseDocument("{}");

  if (!parsedDocument || !isMap(parsedDocument.contents)) {
    document.contents = document.createNode({}) as YAMLMap;
  }

  // An endmatter that could not be parsed is rewritten from scratch.
  let changed = Boolean(existingEndmatter) && !parsedDocument;
  changed =
    syncEntryMap(document, "comments", update.comments, commentEntryKeyOrder) ||
    changed;
  changed =
    syncEntryMap(
      document,
      "suggestions",
      update.suggestions,
      suggestionEntryKeyOrder,
    ) || changed;
  changed =
    appendDeletedRecords(document, update.appendDeleted ?? []) || changed;

  const contents = document.contents as YAMLMap;
  if (contents.items.length === 0) return null;
  if (!changed && existingEndmatter) return existingEndmatter;

  return `---\n${document.toString({ lineWidth: 0 })}`;
}
