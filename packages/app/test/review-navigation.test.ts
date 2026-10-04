import { describe, expect, it } from "vitest";
import type { CriticComment } from "../src/critic-markup";
import {
  buildReviewNavigationTargets,
  findAdjacentNavigationTarget,
  getNewCommentIds,
  getReviewNavigationShortcutDirection,
  type ReviewNavigationItem,
} from "../src/review-navigation";

function comment(
  id: string,
  overrides: Partial<CriticComment> = {},
): CriticComment {
  return {
    id,
    content: `Comment ${id}`,
    createdAt: "2026-10-01T10:00:00.000Z",
    authorType: "user",
    authorId: "user",
    parentCommentId: null,
    ...overrides,
  };
}

const comments = new Map<string, CriticComment>([
  ["c1", comment("c1", { status: "resolved" })],
  [
    "c2",
    comment("c2", {
      parentCommentId: "c1",
      authorType: "ai",
      authorId: null,
      createdAt: "2026-10-02T09:00:00.000Z",
    }),
  ],
  ["c3", comment("c3")],
  [
    "c4",
    comment("c4", {
      parentCommentId: "c3",
      authorType: "ai",
      authorId: null,
      createdAt: "2026-10-02T09:30:00.000Z",
    }),
  ],
  ["c5", comment("c5")],
]);

const items: ReviewNavigationItem[] = [
  {
    key: "c5",
    rootId: "c5",
    kind: "comment",
    anchorTop: 900,
    commentIds: ["c5"],
  },
  {
    key: "c1",
    rootId: "c1",
    kind: "comment",
    anchorTop: 100,
    commentIds: ["c1"],
  },
  {
    key: "c3",
    rootId: "c3",
    kind: "comment",
    anchorTop: 500,
    commentIds: ["c3"],
  },
];

describe("review navigation", () => {
  it("counts only agent comments written after the last handoff as new", () => {
    expect([
      ...getNewCommentIds(comments.values(), "2026-10-02T00:00:00.000Z"),
    ]).toEqual(["c2", "c4"]);
    expect(getNewCommentIds(comments.values(), null).size).toBe(0);
  });

  it("marks resolved threads as closed and threads with new replies as new", () => {
    const targets = buildReviewNavigationTargets(
      items,
      comments,
      new Set(["c2", "c4"]),
    );

    expect(
      targets.map(({ key, isOpen, isNew }) => ({ key, isOpen, isNew })),
    ).toEqual([
      { key: "c1", isOpen: false, isNew: true },
      { key: "c3", isOpen: true, isNew: true },
      { key: "c5", isOpen: true, isNew: false },
    ]);
  });

  it("steps through open threads in document order, skipping resolved ones and wrapping", () => {
    const targets = buildReviewNavigationTargets(items, comments, new Set());

    expect(findAdjacentNavigationTarget(targets, "open", null, 1)?.key).toBe(
      "c3",
    );
    expect(findAdjacentNavigationTarget(targets, "open", "c3", 1)?.key).toBe(
      "c5",
    );
    expect(findAdjacentNavigationTarget(targets, "open", "c5", 1)?.key).toBe(
      "c3",
    );
    expect(findAdjacentNavigationTarget(targets, "open", "c3", -1)?.key).toBe(
      "c5",
    );
    expect(findAdjacentNavigationTarget(targets, "open", null, -1)?.key).toBe(
      "c5",
    );
  });

  it("can restrict navigation to threads with new activity", () => {
    const targets = buildReviewNavigationTargets(
      items,
      comments,
      new Set(["c2", "c4"]),
    );

    expect(findAdjacentNavigationTarget(targets, "new", null, 1)?.key).toBe(
      "c1",
    );
    expect(findAdjacentNavigationTarget(targets, "new", "c1", 1)?.key).toBe(
      "c3",
    );
    expect(
      findAdjacentNavigationTarget(
        buildReviewNavigationTargets(items, comments, new Set()),
        "new",
        null,
        1,
      ),
    ).toBeNull();
  });

  it("maps the navigation shortcuts per platform", () => {
    const keys = { altKey: true, shiftKey: false };
    expect(
      getReviewNavigationShortcutDirection(
        { ...keys, key: "ArrowDown", metaKey: true, ctrlKey: false },
        "MacIntel",
      ),
    ).toBe(1);
    expect(
      getReviewNavigationShortcutDirection(
        { ...keys, key: "ArrowUp", metaKey: false, ctrlKey: true },
        "Linux x86_64",
      ),
    ).toBe(-1);
    expect(
      getReviewNavigationShortcutDirection(
        { ...keys, key: "ArrowDown", metaKey: false, ctrlKey: true },
        "MacIntel",
      ),
    ).toBeNull();
  });
});
