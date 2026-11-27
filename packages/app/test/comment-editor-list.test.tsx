// Ported from kudzuweb/roughdraftplus #8 (PR #31, collapsed threads) and #9
// (PR #50, the approve action on an agent reply, which in this fork is the
// quick path to Resolve).
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentEditorList } from "../src/CommentEditorList";
import type { CriticComment } from "../src/critic-markup";

function queryByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

function getByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  const element = queryByTestId<T>(container, testId);
  expect(element).not.toBeNull();
  return element as T;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function createThread(replyCount: number): CriticComment[] {
  const root: CriticComment = {
    id: "root",
    content: "Root comment",
    createdAt: "2026-04-24T00:00:00.000Z",
  };
  const replies = Array.from({ length: replyCount }, (_, index) => ({
    id: `r${index + 1}`,
    content: `Reply ${index + 1}`,
    createdAt: `2026-04-24T00:00:0${index + 1}.000Z`,
    parentCommentId: "root",
  }));

  return [root, ...replies];
}

describe("CommentEditorList reply collapsing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderList(
    comments: CriticComment[],
    variant: "rail" | "banner" = "rail",
  ) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <CommentEditorList
            comments={comments}
            variant={variant}
            onDeleteComment={vi.fn()}
            onUpdateComment={vi.fn()}
            onReplyComment={vi.fn()}
          />
        </TooltipProvider>,
      );
    });
  }

  it("opens a collapsed thread when one of its hidden replies is selected", async () => {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <CommentEditorList
            comments={createThread(3)}
            variant="rail"
            selectedCommentId="r1"
            onDeleteComment={vi.fn()}
            onUpdateComment={vi.fn()}
          />
        </TooltipProvider>,
      );
    });

    expect(queryByTestId(container, "comment-rail-r1")).not.toBeNull();
    expect(
      queryByTestId(container, "comment-rail-root-action-collapse-replies"),
    ).not.toBeNull();
  });

  it("renders a thread with one reply in full without a toggle", async () => {
    await renderList(createThread(1));

    expect(queryByTestId(container, "comment-rail-root")).not.toBeNull();
    expect(queryByTestId(container, "comment-rail-r1")).not.toBeNull();
    expect(
      queryByTestId(container, "comment-rail-root-action-expand-replies"),
    ).toBeNull();
    expect(
      queryByTestId(container, "comment-rail-root-action-collapse-replies"),
    ).toBeNull();
  });

  it("collapses a thread with several replies to the anchor plus the newest reply", async () => {
    await renderList(createThread(3));

    expect(queryByTestId(container, "comment-rail-root")).not.toBeNull();
    expect(queryByTestId(container, "comment-rail-r1")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r2")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r3")).not.toBeNull();

    const expandButton = getByTestId<HTMLButtonElement>(
      container,
      "comment-rail-root-action-expand-replies",
    );
    expect(expandButton.textContent).toContain("2 earlier replies");
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands to every reply in order and collapses back to the default", async () => {
    await renderList(createThread(3));

    await click(
      getByTestId(container, "comment-rail-root-action-expand-replies"),
    );

    const visibleIds = [
      ...container.querySelectorAll(
        '[data-testid="comment-rail-r1"], [data-testid="comment-rail-r2"], [data-testid="comment-rail-r3"]',
      ),
    ].map((element) => element.getAttribute("data-testid"));
    expect(visibleIds).toEqual([
      "comment-rail-r1",
      "comment-rail-r2",
      "comment-rail-r3",
    ]);
    expect(
      queryByTestId(container, "comment-rail-root-action-expand-replies"),
    ).toBeNull();

    const collapseButton = getByTestId<HTMLButtonElement>(
      container,
      "comment-rail-root-action-collapse-replies",
    );
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
    await click(collapseButton);

    expect(queryByTestId(container, "comment-rail-r1")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r2")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r3")).not.toBeNull();
    expect(
      queryByTestId(container, "comment-rail-root-action-expand-replies"),
    ).not.toBeNull();
  });

  it("applies the same collapsing to the banner variant used in prose", async () => {
    await renderList(createThread(2), "banner");

    expect(queryByTestId(container, "comment-banner-r1")).toBeNull();
    expect(queryByTestId(container, "comment-banner-r2")).not.toBeNull();
    expect(
      getByTestId(container, "comment-banner-root-action-expand-replies")
        .textContent,
    ).toContain("1 earlier reply");
  });

  it("keeps a collapsed thread expanded while a hidden reply is being edited, even after the pending focus clears", async () => {
    const comments = createThread(3);
    const renderWithPendingFocus = async (
      pendingFocusCommentId: string | null,
    ) => {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <CommentEditorList
              comments={comments}
              variant="rail"
              pendingFocusCommentId={pendingFocusCommentId}
              onDeleteComment={vi.fn()}
              onUpdateComment={vi.fn()}
              onReplyComment={vi.fn()}
            />
          </TooltipProvider>,
        );
      });
    };

    await renderWithPendingFocus("r1");

    expect(queryByTestId(container, "comment-rail-r1-editor")).not.toBeNull();
    expect(queryByTestId(container, "comment-rail-r2")).not.toBeNull();

    await renderWithPendingFocus(null);

    expect(queryByTestId(container, "comment-rail-r1-editor")).not.toBeNull();
    expect(queryByTestId(container, "comment-rail-r2")).not.toBeNull();
    expect(
      queryByTestId(container, "comment-rail-root-action-collapse-replies"),
    ).not.toBeNull();

    await click(getByTestId(container, "comment-rail-r1-action-cancel"));

    expect(queryByTestId(container, "comment-rail-r1-editor")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r1")).toBeNull();
    expect(queryByTestId(container, "comment-rail-r3")).not.toBeNull();
    expect(
      queryByTestId(container, "comment-rail-root-action-expand-replies"),
    ).not.toBeNull();
  });
});

function createAgentThread(): CriticComment[] {
  return [
    {
      id: "root",
      content: "Root comment",
      createdAt: "2026-04-24T00:00:00.000Z",
    },
    {
      id: "a1",
      content: "First agent answer",
      createdAt: "2026-04-24T00:00:01.000Z",
      authorType: "ai",
      parentCommentId: "root",
    },
    {
      id: "u1",
      content: "Reviewer follow-up",
      createdAt: "2026-04-24T00:00:02.000Z",
      parentCommentId: "root",
    },
    {
      id: "a2",
      content: "Newest agent answer",
      createdAt: "2026-04-24T00:00:03.000Z",
      authorType: "ai",
      parentCommentId: "root",
    },
  ];
}

describe("CommentEditorList approve action", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderList({
    pendingApprovalCommentIds = [],
    onApproveComment = vi.fn(),
    onRevokeApproval = vi.fn(),
    onDeleteComment = vi.fn(),
  }: Partial<{
    pendingApprovalCommentIds: string[];
    onApproveComment: ReturnType<typeof vi.fn>;
    onRevokeApproval: ReturnType<typeof vi.fn>;
    onDeleteComment: ReturnType<typeof vi.fn>;
  }> = {}) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <CommentEditorList
            comments={createAgentThread()}
            variant="rail"
            pendingApprovalCommentIds={pendingApprovalCommentIds}
            onApproveComment={onApproveComment}
            onRevokeApproval={onRevokeApproval}
            onDeleteComment={onDeleteComment}
            onUpdateComment={vi.fn()}
            onReplyComment={vi.fn()}
          />
        </TooltipProvider>,
      );
    });

    return { onApproveComment, onRevokeApproval, onDeleteComment };
  }

  it("offers approval only on agent replies, to the left of the reply action", async () => {
    await renderList();

    const approveButton = getByTestId(
      container,
      "comment-rail-a2-action-approve",
    );
    const replyButton = getByTestId(container, "comment-rail-a2-action-reply");
    expect(
      approveButton.compareDocumentPosition(replyButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      queryByTestId(container, "comment-rail-root-action-approve"),
    ).toBeNull();

    await click(
      getByTestId(container, "comment-rail-root-action-expand-replies"),
    );

    expect(
      queryByTestId(container, "comment-rail-u1-action-approve"),
    ).toBeNull();
    expect(
      queryByTestId(container, "comment-rail-a1-action-approve"),
    ).not.toBeNull();
  });

  it("swaps the checkmark for an inline confirm and records the approval only on confirm", async () => {
    const { onApproveComment, onDeleteComment } = await renderList();

    await click(getByTestId(container, "comment-rail-a2-action-approve"));

    expect(
      queryByTestId(container, "comment-rail-a2-action-approve"),
    ).toBeNull();
    expect(
      getByTestId(container, "comment-rail-a2-approve-confirm").textContent,
    ).toContain("Approve");

    await click(
      getByTestId(container, "comment-rail-a2-action-approve-cancel"),
    );

    expect(
      queryByTestId(container, "comment-rail-a2-approve-confirm"),
    ).toBeNull();
    expect(
      queryByTestId(container, "comment-rail-a2-action-approve"),
    ).not.toBeNull();
    expect(onApproveComment).not.toHaveBeenCalled();

    await click(getByTestId(container, "comment-rail-a2-action-approve"));
    await click(
      getByTestId(container, "comment-rail-a2-action-approve-confirm"),
    );

    expect(onApproveComment).toHaveBeenCalledTimes(1);
    expect(onApproveComment).toHaveBeenCalledWith("a2");
    expect(onDeleteComment).not.toHaveBeenCalled();
  });

  it("shows a pending approval on the reply and lets it be undone", async () => {
    const { onRevokeApproval } = await renderList({
      pendingApprovalCommentIds: ["a2"],
    });

    expect(
      getByTestId(container, "comment-rail-a2-approval-pending").textContent,
    ).toContain("Approved");
    expect(
      queryByTestId(container, "comment-rail-a2-action-approve"),
    ).toBeNull();

    await click(getByTestId(container, "comment-rail-a2-action-unapprove"));

    expect(onRevokeApproval).toHaveBeenCalledWith("a2");
  });

  it("approves a reply that only becomes visible after expanding the thread", async () => {
    const { onApproveComment } = await renderList();

    expect(queryByTestId(container, "comment-rail-a1")).toBeNull();
    await click(
      getByTestId(container, "comment-rail-root-action-expand-replies"),
    );
    await click(getByTestId(container, "comment-rail-a1-action-approve"));
    await click(
      getByTestId(container, "comment-rail-a1-action-approve-confirm"),
    );

    expect(onApproveComment).toHaveBeenCalledWith("a1");
  });
  it("offers no approval on a reply in a resolved thread", async () => {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <CommentEditorList
            comments={createAgentThread().map((comment) =>
              comment.id === "root"
                ? { ...comment, status: "resolved" as const }
                : comment,
            )}
            variant="rail"
            selectedCommentId="root"
            onApproveComment={vi.fn()}
            onDeleteComment={vi.fn()}
            onUpdateComment={vi.fn()}
            onReplyComment={vi.fn()}
          />
        </TooltipProvider>,
      );
    });

    expect(
      queryByTestId(container, "comment-rail-a2-action-approve"),
    ).toBeNull();
  });
});

function ApprovalHarness({
  onApproveComment,
}: {
  onApproveComment: (commentId: string) => void;
}) {
  const [pendingApprovalCommentIds, setPendingApprovalCommentIds] = useState<
    string[]
  >([]);

  return (
    <TooltipProvider>
      <CommentEditorList
        comments={createAgentThread()}
        variant="rail"
        pendingApprovalCommentIds={pendingApprovalCommentIds}
        onApproveComment={(commentId) => {
          setPendingApprovalCommentIds((current) => [...current, commentId]);
          onApproveComment(commentId);
        }}
        onRevokeApproval={(commentId) => {
          setPendingApprovalCommentIds((current) =>
            current.filter((pendingId) => pendingId !== commentId),
          );
        }}
        onDeleteComment={vi.fn()}
        onUpdateComment={vi.fn()}
        onReplyComment={vi.fn()}
      />
    </TooltipProvider>
  );
}

describe("CommentEditorList approve focus", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps keyboard focus on the approve controls through confirm, cancel, and undo", async () => {
    const onApproveComment = vi.fn();
    await act(async () => {
      root.render(<ApprovalHarness onApproveComment={onApproveComment} />);
    });

    const approveButton = getByTestId(
      container,
      "comment-rail-a2-action-approve",
    );
    approveButton.focus();
    await click(approveButton);

    expect(document.activeElement).toBe(
      getByTestId(container, "comment-rail-a2-action-approve-confirm"),
    );

    await click(
      getByTestId(container, "comment-rail-a2-action-approve-cancel"),
    );

    expect(document.activeElement).toBe(
      getByTestId(container, "comment-rail-a2-action-approve"),
    );

    await click(getByTestId(container, "comment-rail-a2-action-approve"));
    await click(
      getByTestId(container, "comment-rail-a2-action-approve-confirm"),
    );

    expect(onApproveComment).toHaveBeenCalledWith("a2");
    expect(document.activeElement).toBe(
      getByTestId(container, "comment-rail-a2-action-unapprove"),
    );

    await click(getByTestId(container, "comment-rail-a2-action-unapprove"));

    expect(document.activeElement).toBe(
      getByTestId(container, "comment-rail-a2-action-approve"),
    );
  });
});
