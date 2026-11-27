// Ported from kudzuweb/roughdraftplus #9 (PR #50): the approve action on an
// agent reply. In this fork approving is the quick path to Resolve.
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
