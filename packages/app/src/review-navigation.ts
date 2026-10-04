import { isApplePlatform } from "./comment-shortcuts";
import { type CriticComment, getCommentDescendantIds } from "./critic-markup";

/**
 * Review navigation: lets the reviewer jump between threads that still need
 * attention (unresolved) and threads with activity that is new since their
 * last "I'm done", without scrolling through old discussion.
 */

export interface ReviewNavigationItem {
  /** Rail key of the thread (root comment id or suggestion id). */
  key: string;
  /** Comment or suggestion id that represents the thread. */
  rootId: string;
  kind: "comment" | "suggestion" | "document";
  anchorTop: number;
  /** Comment ids that belong to the thread, root first. */
  commentIds: string[];
}

export interface ReviewNavigationTarget extends ReviewNavigationItem {
  isOpen: boolean;
  isNew: boolean;
}

export type ReviewNavigationFilter = "open" | "new";

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * Comments written by someone other than the reviewer after their last
 * handoff. Without a recorded handoff nothing counts as new.
 */
export function getNewCommentIds(
  comments: Iterable<CriticComment>,
  since: string | null,
): Set<string> {
  const sinceTime = parseTime(since);
  const newIds = new Set<string>();
  if (sinceTime === null) return newIds;

  for (const comment of comments) {
    const createdAt = parseTime(comment.createdAt);
    if (createdAt === null || createdAt <= sinceTime) continue;
    if (comment.authorType !== "ai") continue;
    newIds.add(comment.id);
  }

  return newIds;
}

export function isResolvedComment(comment: CriticComment | undefined) {
  return comment?.status === "resolved";
}

export function buildReviewNavigationTargets(
  items: ReviewNavigationItem[],
  comments: ReadonlyMap<string, CriticComment>,
  newCommentIds: ReadonlySet<string>,
): ReviewNavigationTarget[] {
  return [...items]
    .sort((left, right) => left.anchorTop - right.anchorTop)
    .map((item) => {
      const threadIds = [
        ...new Set([
          ...item.commentIds,
          ...item.commentIds.flatMap((id) =>
            getCommentDescendantIds(id, comments),
          ),
        ]),
      ];
      const root = comments.get(item.rootId);
      return {
        ...item,
        commentIds: threadIds,
        isOpen: item.kind === "suggestion" || !isResolvedComment(root),
        isNew: threadIds.some((id) => newCommentIds.has(id)),
      };
    });
}

export function matchesNavigationFilter(
  target: ReviewNavigationTarget,
  filter: ReviewNavigationFilter,
): boolean {
  return filter === "new" ? target.isNew : target.isOpen;
}

/**
 * The next (or previous) target after the current one, wrapping around.
 * When nothing is selected, "next" starts at the first target and
 * "previous" at the last.
 */
export function findAdjacentNavigationTarget(
  targets: ReviewNavigationTarget[],
  filter: ReviewNavigationFilter,
  currentKey: string | null,
  direction: 1 | -1,
): ReviewNavigationTarget | null {
  const candidates = targets.filter((target) =>
    matchesNavigationFilter(target, filter),
  );
  if (candidates.length === 0) return null;

  const currentIndex = currentKey
    ? targets.findIndex((target) => target.key === currentKey)
    : -1;
  if (currentIndex === -1) {
    return direction === 1
      ? (candidates[0] ?? null)
      : (candidates.at(-1) ?? null);
  }

  const count = targets.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (((currentIndex + direction * step) % count) + count) % count;
    const target = targets[index];
    if (target && matchesNavigationFilter(target, filter)) return target;
  }

  return null;
}

const lastHandoffStorageKeyPrefix = "roughdraft:last-handoff:";

export function readLastHandoffAt(documentKey: string | null): string | null {
  if (!documentKey) return null;
  try {
    return window.localStorage.getItem(
      `${lastHandoffStorageKeyPrefix}${documentKey}`,
    );
  } catch {
    return null;
  }
}

export function writeLastHandoffAt(
  documentKey: string | null,
  value: string,
): void {
  if (!documentKey) return;
  try {
    window.localStorage.setItem(
      `${lastHandoffStorageKeyPrefix}${documentKey}`,
      value,
    );
  } catch {
    // Storage can be unavailable (private windows); "new" badges are a
    // convenience, so losing them is acceptable.
  }
}

interface ShortcutEventLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** ⌥⌘↓ / ⌥⌘↑ on macOS, Ctrl+Alt+↓ / Ctrl+Alt+↑ elsewhere. */
export function getReviewNavigationShortcutDirection(
  event: ShortcutEventLike,
  platform?: string | null,
): 1 | -1 | null {
  if (event.shiftKey || !event.altKey) return null;
  const primary = isApplePlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primary) return null;
  if (event.key === "ArrowDown") return 1;
  if (event.key === "ArrowUp") return -1;
  return null;
}

export function getReviewNavigationShortcutLabels(platform?: string | null) {
  return isApplePlatform(platform)
    ? { next: "⌥⌘↓", previous: "⌥⌘↑" }
    : { next: "Ctrl+Alt+↓", previous: "Ctrl+Alt+↑" };
}
