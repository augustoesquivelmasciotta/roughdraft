import fs from "node:fs";
import {
  appendRoughdraftReply,
  extractRoughdraftReviewIndex,
  type RfmReviewItem,
} from "@roughdraft/rfm";
import type { ReviewCommentAddedItem } from "./review-events.js";

// The agent's author name. The app writes "user" for the reviewer's own
// comments and replies, so anything that is not an agent counts as the
// reviewer (a comment with no author included).
const AGENT_AUTHOR = "ai";

function isAgentAuthored(item: RfmReviewItem): boolean {
  return item.author?.trim().toLowerCase() === AGENT_AUTHOR;
}

// Why two checks: an item without an explicit id gets one derived from its
// position, and the app may renumber ids on save. An item counts as new only
// when neither its id nor its content was in the old document.
function signature(item: RfmReviewItem): string {
  return JSON.stringify([
    item.kind,
    item.parentId,
    item.anchorText ?? null,
    item.text,
  ]);
}

/**
 * Comments and replies a save added by the reviewer: review items of kind
 * comment or reply that are in `newContent` and not in `oldContent`, written
 * by someone other than the agent. Suggestions, edits to an existing item and
 * agent-authored items are not included.
 */
export function detectNewReviewerComments(
  oldContent: string,
  newContent: string,
): ReviewCommentAddedItem[] {
  const before = extractRoughdraftReviewIndex(oldContent).items;
  const oldIds = new Set(before.map((item) => item.id));
  // A count per signature, so two identical replies are still two items.
  const oldSignatures = new Map<string, number>();
  for (const item of before) {
    oldSignatures.set(
      signature(item),
      (oldSignatures.get(signature(item)) ?? 0) + 1,
    );
  }

  const added: ReviewCommentAddedItem[] = [];
  for (const item of extractRoughdraftReviewIndex(newContent).items) {
    if (item.kind !== "comment" && item.kind !== "reply") continue;
    if (isAgentAuthored(item)) continue;
    if (oldIds.has(item.id)) continue;
    const key = signature(item);
    const remaining = oldSignatures.get(key) ?? 0;
    if (remaining > 0) {
      oldSignatures.set(key, remaining - 1);
      continue;
    }
    added.push({
      id: item.id,
      kind: item.kind,
      parentId: item.parentId,
      text: item.text,
      anchorText: item.anchorText ?? null,
      author: item.author,
    });
  }
  return added;
}

export interface ReplyToCommentResult {
  documentPath: string;
  id: string;
  parentId: string;
}

/**
 * Append a reply to an existing comment or suggestion and write the file.
 * The one write behind `roughdraft reply` and the MCP
 * `roughdraft_reply_to_comment` tool.
 */
export function replyToComment(
  documentPath: string,
  options: { parentId: string; message: string; author?: string },
): ReplyToCommentResult {
  const markdown = fs.readFileSync(documentPath, "utf8");
  const updated = appendRoughdraftReply(markdown, {
    parentId: options.parentId,
    message: options.message,
    author: options.author ?? "AI",
  });
  fs.writeFileSync(documentPath, updated);

  const known = new Set(
    extractRoughdraftReviewIndex(markdown).items.map((item) => item.id),
  );
  const created = extractRoughdraftReviewIndex(updated).items.find(
    (item) => !known.has(item.id) && item.parentId === options.parentId,
  );
  return {
    documentPath,
    id: created?.id ?? "",
    parentId: options.parentId,
  };
}
