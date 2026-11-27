import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Pencil,
  Reply,
  RotateCcw,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import {
  buildCommentThreads,
  type CriticComment,
  type CriticCommentThread,
} from "./critic-markup";
import {
  collapseCommentThread,
  getCommentThreadReplies,
} from "./document-comments";
import { cn } from "./lib/utils";

interface CommentEditorListProps {
  comments: CriticComment[];
  variant?: "banner" | "rail";
  selectedCommentId?: string | null;
  hoveredCommentId?: string | null;
  className?: string;
  testId?: string;
  interactive?: boolean;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, nextContent: string) => void;
  onSelectComment?: (commentId: string) => void;
  onHoverComment?: (commentId: string | null) => void;
  onFocusComment?: (commentId: string) => void;
  onReplyComment?: (commentId: string) => void;
  /** Marks a thread resolved (root comments only). */
  onResolveComment?: (commentId: string) => void;
  onReopenComment?: (commentId: string) => void;
  /** Comments added since the reviewer's last handoff. */
  newCommentIds?: ReadonlySet<string>;
  pendingFocusCommentId?: string | null;
  newCommentDraftIds?: string[];
  onAutoFocusComment?: (commentId: string) => void;
  /**
   * Approvals the reviewer confirmed that apply on "I'm done". An agent reply
   * offers the approve check when `onApproveComment` is set; other comments
   * (a suggestion card's root) opt in through `approvableCommentIds`.
   */
  pendingApprovalCommentIds?: readonly string[];
  approvableCommentIds?: readonly string[];
  /** Offer the approve check on agent replies (default true). */
  approveAgentReplies?: boolean;
  pendingApprovalBadges?: Readonly<Record<string, PendingApprovalBadge>>;
  onApproveComment?: (commentId: string) => void;
  onRevokeApproval?: (commentId: string) => void;
  renderCommentContent?: (context: CommentContentRenderContext) => ReactNode;
  getCommentActions?: (
    context: CommentActionsRenderContext,
  ) => CommentActionDefinition[];
}

export interface PendingApprovalBadge {
  label: string;
  title: string;
}

const DEFAULT_PENDING_APPROVAL_BADGE: PendingApprovalBadge = {
  label: "Approved",
  title: "Resolves this thread when you click I'm done",
};

export interface CommentActionDefinition {
  key: string;
  label: string;
  tone?: "neutral" | "danger" | "success";
  presentation?: "default" | "popover";
  icon: ReactNode;
  compact?: boolean;
  active?: boolean;
  onClick: (event: MouseEvent) => void;
}

type CommentApprovalState = "none" | "available" | "confirming" | "pending";

interface CommentApprovalContextValue {
  pendingIds: ReadonlySet<string>;
  approvableIds: ReadonlySet<string>;
  approveAgentReplies: boolean;
  badges: Readonly<Record<string, PendingApprovalBadge>>;
  confirmingId: string | null;
  setConfirmingId: (commentId: string | null) => void;
  onApprove?: (commentId: string) => void;
  onRevoke?: (commentId: string) => void;
}

const CommentApprovalContext = createContext<CommentApprovalContextValue>({
  pendingIds: new Set(),
  approvableIds: new Set(),
  approveAgentReplies: false,
  badges: {},
  confirmingId: null,
  setConfirmingId: () => {},
});

export interface CommentContentRenderContext {
  comment: CriticComment;
  depth: number;
  isEditing: boolean;
  defaultContent: ReactNode;
}

export interface CommentActionsRenderContext {
  comment: CriticComment;
  depth: number;
  isEditing: boolean;
  defaultActions: CommentActionDefinition[];
}

interface CommentReplyCollapseState {
  isExpanded: boolean;
  hiddenReplyCount: number;
  onToggle: () => void;
}

interface CommentThreadView {
  thread: CriticCommentThread;
  replyCollapse: CommentReplyCollapseState | null;
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    ),
  );
}

function isReplyShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === "r" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

export function CommentEditorList({
  comments,
  variant = "banner",
  selectedCommentId = null,
  hoveredCommentId = null,
  className,
  testId,
  interactive = true,
  onDeleteComment,
  onUpdateComment,
  onSelectComment,
  onHoverComment,
  onFocusComment,
  onReplyComment,
  onResolveComment,
  onReopenComment,
  newCommentIds,
  pendingFocusCommentId = null,
  newCommentDraftIds = [],
  onAutoFocusComment,
  pendingApprovalCommentIds,
  approvableCommentIds,
  approveAgentReplies = true,
  pendingApprovalBadges,
  onApproveComment,
  onRevokeApproval,
  renderCommentContent,
  getCommentActions,
}: CommentEditorListProps) {
  const textareaRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingCommentIds, setEditingCommentIds] = useState<string[]>([]);
  const [confirmingApprovalId, setConfirmingApprovalId] = useState<
    string | null
  >(null);
  const approvalContext = useMemo<CommentApprovalContextValue>(
    () => ({
      pendingIds: new Set(pendingApprovalCommentIds ?? []),
      approvableIds: new Set(approvableCommentIds ?? []),
      approveAgentReplies,
      badges: pendingApprovalBadges ?? {},
      confirmingId: confirmingApprovalId,
      setConfirmingId: setConfirmingApprovalId,
      onApprove: onApproveComment,
      onRevoke: onRevokeApproval,
    }),
    [
      approvableCommentIds,
      approveAgentReplies,
      confirmingApprovalId,
      onApproveComment,
      onRevokeApproval,
      pendingApprovalBadges,
      pendingApprovalCommentIds,
    ],
  );
  const [expandedThreadIds, setExpandedThreadIds] = useState<string[]>([]);
  const threads = useMemo(() => buildCommentThreads(comments), [comments]);
  // A thread with more than one reply shows its root and the newest reply
  // until it is expanded (ported from kudzuweb/roughdraftplus #8). A hidden
  // reply that is being edited or is selected opens the thread.
  const threadViews = useMemo<CommentThreadView[]>(
    () =>
      threads.map((thread) => {
        const rootCommentId = thread.comment.id;
        const collapsed = collapseCommentThread(thread);

        if (collapsed.hiddenReplyCount === 0) {
          return { thread, replyCollapse: null };
        }

        const visibleReplyIds = new Set(
          getCommentThreadReplies(collapsed.thread).map((reply) => reply.id),
        );
        const opensThread = getCommentThreadReplies(thread).some(
          (reply) =>
            !visibleReplyIds.has(reply.id) &&
            (editingCommentIds.includes(reply.id) ||
              reply.id === selectedCommentId),
        );
        const isExpanded =
          expandedThreadIds.includes(rootCommentId) || opensThread;
        const onToggle = () => {
          setExpandedThreadIds((current) =>
            isExpanded
              ? current.filter((threadId) => threadId !== rootCommentId)
              : [...current, rootCommentId],
          );
        };

        return {
          thread: isExpanded ? thread : collapsed.thread,
          replyCollapse: {
            isExpanded,
            hiddenReplyCount: collapsed.hiddenReplyCount,
            onToggle,
          },
        };
      }),
    [editingCommentIds, expandedThreadIds, selectedCommentId, threads],
  );
  const commentMap = useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments],
  );
  const hasActiveSelection =
    !!selectedCommentId &&
    comments.some((comment) => comment.id === selectedCommentId);
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !onReplyComment) return;
    if (!isReplyShortcut(event)) return;
    if (isEditableShortcutTarget(event.target)) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const rootThread = target.closest<HTMLElement>(
      "[data-comment-thread-root-id]",
    );
    const rootCommentId = rootThread?.dataset.commentThreadRootId;
    if (!rootCommentId) return;

    event.preventDefault();
    event.stopPropagation();
    onReplyComment(rootCommentId);
  };

  useEffect(() => {
    const validCommentIds = new Set(comments.map((comment) => comment.id));

    setDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([commentId]) =>
          validCommentIds.has(commentId),
        ),
      ),
    );
    setEditingCommentIds((current) =>
      current.filter((commentId) => validCommentIds.has(commentId)),
    );
    setConfirmingApprovalId((current) =>
      current && validCommentIds.has(current) ? current : null,
    );
    setExpandedThreadIds((current) =>
      current.filter((commentId) => validCommentIds.has(commentId)),
    );
  }, [comments]);

  useEffect(() => {
    if (!interactive) return;
    if (!pendingFocusCommentId) return;

    const pendingComment = commentMap.get(pendingFocusCommentId);
    if (!pendingComment) return;

    setDrafts((current) => ({
      ...current,
      [pendingFocusCommentId]:
        current[pendingFocusCommentId] ?? pendingComment.content,
    }));
    setEditingCommentIds((current) =>
      current.includes(pendingFocusCommentId)
        ? current
        : [...current, pendingFocusCommentId],
    );
  }, [commentMap, interactive, pendingFocusCommentId]);

  useEffect(() => {
    if (!interactive) return;
    if (!pendingFocusCommentId) return;
    if (!editingCommentIds.includes(pendingFocusCommentId)) return;

    const target = textareaRefs.current.get(pendingFocusCommentId);
    if (!target || target.offsetParent === null) return;

    target.focus();
    const cursorPosition = target.value.length;
    target.setSelectionRange(cursorPosition, cursorPosition);
    onAutoFocusComment?.(pendingFocusCommentId);
  }, [
    editingCommentIds,
    interactive,
    onAutoFocusComment,
    pendingFocusCommentId,
  ]);

  if (comments.length === 0) return null;

  const startEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    setDrafts((current) => ({
      ...current,
      [commentId]: current[commentId] ?? comment.content,
    }));
    setEditingCommentIds((current) =>
      current.includes(commentId) ? current : [...current, commentId],
    );
    onSelectComment?.(commentId);
  };

  const stopEditingComment = (commentId: string) => {
    setEditingCommentIds((current) =>
      current.filter((currentCommentId) => currentCommentId !== commentId),
    );
  };

  const submitEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    const nextContent = (drafts[commentId] ?? comment.content).trim();

    if (nextContent.length === 0) {
      onDeleteComment(commentId);
      return;
    }

    if (nextContent !== comment.content) {
      onUpdateComment(commentId, nextContent);
    }

    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[commentId];
      return nextDrafts;
    });
    stopEditingComment(commentId);
  };

  const cancelEditingComment = (commentId: string) => {
    const comment = commentMap.get(commentId);
    if (!comment) return;

    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[commentId];
      return nextDrafts;
    });

    if (comment.content.trim().length === 0) {
      onDeleteComment(commentId);
      return;
    }

    stopEditingComment(commentId);
  };

  return (
    <CommentApprovalContext.Provider value={approvalContext}>
      <div
        data-testid={testId}
        data-comment-thread-container="true"
        className={cn(
          variant === "banner"
            ? cn(
                "space-y-2 rounded-xl border border-transparent bg-transparent p-3 shadow-none transition-[background-color,border-color,box-shadow] duration-200 ease-out",
                hasActiveSelection
                  ? "border-[#DFDFDC] dark:border-slate-600 bg-white dark:bg-card shadow-[0_20px_48px_rgba(57,47,38,0.14)] dark:shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
                  : "",
              )
            : "space-y-1.5 px-4 py-3",
          className,
        )}
        onKeyDownCapture={handleKeyDownCapture}
      >
        {threadViews.map(({ thread, replyCollapse }, index) => (
          <CommentThreadNode
            key={thread.comment.id}
            thread={thread}
            depth={0}
            index={index}
            isLast={index === threadViews.length - 1}
            parentLines={[]}
            replyCollapse={replyCollapse}
            variant={variant}
            interactive={interactive}
            isActiveThread={threadContainsComment(thread, selectedCommentId)}
            onResolveComment={onResolveComment}
            onReopenComment={onReopenComment}
            newCommentIds={newCommentIds}
            drafts={drafts}
            newCommentDraftIds={newCommentDraftIds}
            editingCommentIds={editingCommentIds}
            pendingFocusCommentId={pendingFocusCommentId}
            selectedCommentId={selectedCommentId}
            hoveredCommentId={hoveredCommentId}
            textareaRefs={textareaRefs}
            onDeleteComment={onDeleteComment}
            onUpdateComment={onUpdateComment}
            onSelectComment={onSelectComment}
            onHoverComment={onHoverComment}
            onFocusComment={onFocusComment}
            onReplyComment={onReplyComment}
            onStartEditingComment={startEditingComment}
            onSubmitEditingComment={submitEditingComment}
            onCancelEditingComment={cancelEditingComment}
            renderCommentContent={renderCommentContent}
            getCommentActions={getCommentActions}
            onChangeDraft={(commentId, nextContent) => {
              setDrafts((current) => ({
                ...current,
                [commentId]: nextContent,
              }));
            }}
          />
        ))}
      </div>
    </CommentApprovalContext.Provider>
  );
}

function threadContainsComment(
  thread: CriticCommentThread,
  commentId: string | null,
): boolean {
  if (!commentId) return false;
  if (thread.comment.id === commentId) return true;
  return thread.replies.some((reply) =>
    threadContainsComment(reply, commentId),
  );
}

function countThreadReplies(thread: CriticCommentThread): number {
  return thread.replies.reduce(
    (count, reply) => count + 1 + countThreadReplies(reply),
    0,
  );
}

interface CommentThreadNodeProps {
  thread: CriticCommentThread;
  depth: number;
  index: number;
  isLast: boolean;
  parentLines: boolean[];
  variant: "banner" | "rail";
  interactive: boolean;
  /** The selected comment is in this thread (expands resolved threads). */
  isActiveThread?: boolean;
  /** The root of this comment's thread is resolved. */
  threadResolved?: boolean;
  /** Root only: earlier replies hidden behind a toggle. */
  replyCollapse?: CommentReplyCollapseState | null;
  onResolveComment?: (commentId: string) => void;
  onReopenComment?: (commentId: string) => void;
  newCommentIds?: ReadonlySet<string>;
  drafts: Record<string, string>;
  newCommentDraftIds: string[];
  editingCommentIds: string[];
  pendingFocusCommentId: string | null;
  selectedCommentId: string | null;
  hoveredCommentId: string | null;
  textareaRefs: MutableRefObject<Map<string, HTMLTextAreaElement>>;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, nextContent: string) => void;
  onSelectComment?: (commentId: string) => void;
  onHoverComment?: (commentId: string | null) => void;
  onFocusComment?: (commentId: string) => void;
  onReplyComment?: (commentId: string) => void;
  onStartEditingComment: (commentId: string) => void;
  onSubmitEditingComment: (commentId: string) => void;
  onCancelEditingComment: (commentId: string) => void;
  renderCommentContent?: (context: CommentContentRenderContext) => ReactNode;
  getCommentActions?: (
    context: CommentActionsRenderContext,
  ) => CommentActionDefinition[];
  onChangeDraft: (commentId: string, nextContent: string) => void;
}

const COMMENT_TREE_INDENT = 16;
const COMMENT_TREE_ELBOW_TOP = 12;
const COMMENT_TREE_ROW_GAP = 10;
const COMMENT_AVATAR_SIZE = 20;
const COMMENT_AVATAR_CENTER = 12;

function CommentActionButton({
  label,
  testId,
  tone = "neutral",
  presentation = "default",
  icon,
  compact = false,
  active,
  ariaExpanded,
  className,
  onClick,
}: {
  label: string;
  testId?: string;
  tone?: "neutral" | "danger" | "success";
  presentation?: "default" | "popover";
  icon: ReactNode;
  compact?: boolean;
  active?: boolean;
  ariaExpanded?: boolean;
  className?: string;
  onClick: (event: MouseEvent) => void;
}) {
  const button = (
    <Button
      type="button"
      aria-label={compact ? label : undefined}
      aria-pressed={active}
      aria-expanded={ariaExpanded}
      data-testid={testId}
      variant="ghost"
      size={compact ? "icon-xs" : "sm"}
      className={cn(
        presentation === "popover" && !compact
          ? "h-9 w-full rounded-xl bg-[#E8E3DB] px-3 py-2 text-sm font-bold normal-case tracking-normal text-black shadow-[inset_0_1px_0_rgba(255,251,245,0.72)] hover:bg-[#ded8ce] hover:text-black dark:bg-slate-700 dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] dark:hover:bg-slate-600 dark:hover:text-slate-100"
          : compact
            ? "rounded-full border border-transparent transition-colors duration-150"
            : "h-7 rounded-full border border-transparent px-2.5 text-[11px] font-medium tracking-[0.08em] uppercase transition-colors duration-150",
        presentation === "popover"
          ? ""
          : tone === "danger"
            ? active
              ? "bg-rose-100 text-rose-700 hover:bg-rose-200 dark:bg-rose-900/40 dark:text-rose-400 dark:hover:bg-rose-900/60"
              : "text-stone-400 hover:bg-rose-100 hover:text-rose-700 dark:text-stone-500 dark:hover:bg-rose-900/40 dark:hover:text-rose-400"
            : tone === "success"
              ? active
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 hover:text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400 dark:hover:bg-emerald-900/60 dark:hover:text-emerald-300"
                : "text-stone-400 hover:bg-emerald-100 hover:text-emerald-700 dark:text-stone-500 dark:hover:bg-emerald-900/40 dark:hover:text-emerald-400"
              : active
                ? "bg-[#DED8CE]/70 text-stone-700 dark:bg-slate-700 dark:text-stone-200"
                : "text-stone-400 hover:bg-[#DED8CE]/45 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-slate-700 dark:hover:text-stone-300",
        className,
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {icon}
      {compact ? null : <span>{label}</span>}
    </Button>
  );

  if (!compact) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CommentThreadNode({
  thread,
  depth,
  index,
  isLast,
  parentLines,
  variant,
  interactive,
  isActiveThread = false,
  threadResolved = false,
  replyCollapse = null,
  onResolveComment,
  onReopenComment,
  newCommentIds,
  drafts,
  newCommentDraftIds,
  editingCommentIds,
  pendingFocusCommentId,
  selectedCommentId,
  hoveredCommentId,
  textareaRefs,
  onDeleteComment,
  onUpdateComment,
  onSelectComment,
  onHoverComment,
  onFocusComment,
  onReplyComment,
  onStartEditingComment,
  onSubmitEditingComment,
  onCancelEditingComment,
  renderCommentContent,
  getCommentActions,
  onChangeDraft,
}: CommentThreadNodeProps) {
  const { comment } = thread;
  const isRootThread = depth === 0;
  const isResolved = isRootThread && comment.status === "resolved";
  const isInResolvedThread = isResolved || threadResolved;
  // Resolved threads stay out of the way until the reviewer opens them.
  const isCollapsedResolved =
    isResolved && !isActiveThread && !editingCommentIds.includes(comment.id);
  const replies = isCollapsedResolved ? [] : thread.replies;
  const hiddenReplyCount = isCollapsedResolved ? countThreadReplies(thread) : 0;
  const hasReplies = replies.length > 0;
  const showReplyCollapse = !isCollapsedResolved && replyCollapse !== null;
  const replyCollapseLabel = replyCollapse
    ? replyCollapse.isExpanded
      ? "Hide earlier replies"
      : `Show ${replyCollapse.hiddenReplyCount} earlier ${
          replyCollapse.hiddenReplyCount === 1 ? "reply" : "replies"
        }`
    : "";
  const isNew = newCommentIds?.has(comment.id) ?? false;
  const isSelected = comment.id === selectedCommentId;
  const isHovered = comment.id === hoveredCommentId;
  const isEditing = interactive && editingCommentIds.includes(comment.id);
  const isAiAuthor = comment.authorType === "ai";
  const userAuthorId = comment.authorId?.trim();
  const authorLabel = isAiAuthor
    ? "AI"
    : userAuthorId && userAuthorId.toLowerCase() !== "user"
      ? userAuthorId
      : "Me";
  const AuthorIcon = isAiAuthor ? Bot : User;
  const draftContent = drafts[comment.id] ?? comment.content;
  const avatarTone = isAiAuthor
    ? variant === "banner"
      ? "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-400"
      : "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-400"
    : variant === "banner"
      ? "border-[#D2C7B8] bg-[#DED8CE] text-stone-700 dark:border-slate-600 dark:bg-slate-700 dark:text-stone-300"
      : "border-[#D2C7B8] bg-[#DED8CE] text-stone-700 dark:border-slate-600 dark:bg-slate-700 dark:text-stone-300";
  const bodyTone =
    variant === "banner"
      ? isSelected
        ? "bg-white"
        : isHovered
          ? "bg-white"
          : "bg-transparent"
      : "bg-transparent";
  const treeLineTone =
    variant === "banner"
      ? "bg-[#DED8CE]/90 dark:bg-slate-600/90"
      : "bg-[#DED8CE]/85 dark:bg-slate-600/85";
  const hasCommentContent = comment.content.trim().length > 0;
  const defaultContent = hasCommentContent ? comment.content : "Empty comment";
  const isNewRootCommentDraft =
    isEditing &&
    depth === 0 &&
    (comment.id === pendingFocusCommentId ||
      newCommentDraftIds.includes(comment.id));
  const renderedContent =
    renderCommentContent?.({
      comment,
      depth,
      isEditing,
      defaultContent,
    }) ?? defaultContent;
  const approval = useContext(CommentApprovalContext);
  const canApprove =
    interactive &&
    !!approval.onApprove &&
    (approval.approvableIds.has(comment.id) ||
      (approval.approveAgentReplies &&
        depth > 0 &&
        isAiAuthor &&
        !isInResolvedThread));
  const approvalState: CommentApprovalState = approval.pendingIds.has(
    comment.id,
  )
    ? "pending"
    : !canApprove
      ? "none"
      : approval.confirmingId === comment.id
        ? "confirming"
        : "available";
  const approvalBadge =
    approval.badges[comment.id] ?? DEFAULT_PENDING_APPROVAL_BADGE;
  const approvalActions: CommentActionDefinition[] =
    approvalState === "available"
      ? [
          {
            key: "approve",
            label: "Approve",
            tone: "success",
            icon: <Check className="size-3.5" />,
            compact: true,
            onClick: (event) => {
              event.stopPropagation();
              approval.setConfirmingId(comment.id);
            },
          },
        ]
      : approvalState === "pending" && approval.onRevoke
        ? [
            {
              key: "unapprove",
              label: "Undo approval",
              tone: "success",
              active: true,
              icon: <Check className="size-3.5" />,
              compact: true,
              onClick: (event) => {
                event.stopPropagation();
                approval.onRevoke?.(comment.id);
              },
            },
          ]
        : [];
  const nodeRef = useRef<HTMLDivElement>(null);
  const previousApprovalStateRef = useRef<CommentApprovalState>(approvalState);

  useLayoutEffect(() => {
    const previousApprovalState = previousApprovalStateRef.current;
    previousApprovalStateRef.current = approvalState;
    if (previousApprovalState === approvalState) return;

    // Each step of the approve swap unmounts the control that was activated,
    // which would drop keyboard focus to the body; hand it to the control
    // that replaced it, but only when focus was in this comment.
    const activeElement = document.activeElement;
    const focusWasHere =
      !activeElement ||
      activeElement === document.body ||
      nodeRef.current?.contains(activeElement);
    if (!focusWasHere) return;

    const focusActionKey =
      approvalState === "confirming"
        ? "approve-confirm"
        : approvalState === "pending"
          ? "unapprove"
          : approvalState === "available"
            ? "approve"
            : null;
    if (!focusActionKey) return;

    nodeRef.current
      ?.querySelector<HTMLElement>(
        `[data-testid="comment-${variant}-${comment.id}-action-${focusActionKey}"]`,
      )
      ?.focus();
  }, [approvalState, comment.id, variant]);

  const defaultActions: CommentActionDefinition[] = isEditing
    ? [
        {
          key: "save",
          label: "Save",
          presentation: isNewRootCommentDraft ? "popover" : "default",
          icon: <Check className="size-3.5" />,
          onClick: (event) => {
            event.stopPropagation();
            onSubmitEditingComment(comment.id);
          },
        },
        {
          key: "cancel",
          label: "Cancel",
          icon: <X className="size-3.5" />,
          onClick: (event) => {
            event.stopPropagation();
            onCancelEditingComment(comment.id);
          },
        },
      ]
    : [
        ...approvalActions,
        {
          key: "reply",
          label: "Reply",
          icon: <Reply className="size-3.5" />,
          compact: true,
          onClick: (event) => {
            event.stopPropagation();
            onReplyComment?.(comment.id);
          },
        },
        ...(isRootThread && isResolved && onReopenComment
          ? [
              {
                key: "reopen",
                label: "Reopen",
                icon: <RotateCcw className="size-3.5" />,
                compact: true,
                onClick: (event: MouseEvent) => {
                  event.stopPropagation();
                  onReopenComment(comment.id);
                },
              } satisfies CommentActionDefinition,
            ]
          : []),
        ...(isRootThread && !isResolved && onResolveComment
          ? [
              {
                key: "resolve",
                label: "Resolve",
                icon: <CircleCheck className="size-3.5" />,
                compact: true,
                onClick: (event: MouseEvent) => {
                  event.stopPropagation();
                  onResolveComment(comment.id);
                },
              } satisfies CommentActionDefinition,
            ]
          : []),
        {
          key: "edit",
          label: "Edit",
          icon: <Pencil className="size-3.5" />,
          compact: true,
          onClick: (event) => {
            event.stopPropagation();
            onStartEditingComment(comment.id);
          },
        },
        {
          key: "delete",
          label: "Delete",
          tone: "danger",
          icon: <Trash2 className="size-3.5" />,
          compact: true,
          onClick: (event) => {
            event.stopPropagation();
            onDeleteComment(comment.id);
          },
        },
      ];
  const defaultVisibleActions = isNewRootCommentDraft
    ? defaultActions.filter((action) => action.key !== "cancel")
    : defaultActions;
  const actions =
    getCommentActions?.({
      comment,
      depth,
      isEditing,
      defaultActions: defaultVisibleActions,
    }) ?? defaultVisibleActions;
  const ancestorGuideOffsets = parentLines.reduce<number[]>(
    (offsets, showLine, guideIndex) => {
      if (showLine) {
        offsets.push(guideIndex * COMMENT_TREE_INDENT + COMMENT_AVATAR_CENTER);
      }
      return offsets;
    },
    [],
  );

  return (
    <div
      ref={nodeRef}
      data-testid={`comment-${variant}-${comment.id}`}
      data-comment-thread-root-id={isRootThread ? comment.id : undefined}
      tabIndex={interactive && isRootThread ? 0 : undefined}
      className={cn(
        "relative transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300 dark:focus-visible:ring-slate-600",
        variant === "rail" &&
          isRootThread &&
          (index > 0
            ? "border-t border-slate-200/80 dark:border-slate-700/80 pt-3"
            : "pt-0"),
      )}
      onClick={() => {
        if (!interactive) return;
        onSelectComment?.(comment.id);
      }}
      onMouseEnter={() => {
        if (!interactive) return;
        onHoverComment?.(comment.id);
      }}
      onMouseLeave={() => {
        if (!interactive) return;
        onHoverComment?.(null);
      }}
      onPointerDown={() => {
        if (!interactive) return;
        onSelectComment?.(comment.id);
      }}
    >
      <div className="relative flex min-w-0 items-stretch">
        {depth > 0 ? (
          <div
            aria-hidden="true"
            className="pointer-events-none relative shrink-0 self-stretch"
            style={{ width: depth * COMMENT_TREE_INDENT }}
          >
            {ancestorGuideOffsets.map((left) => (
              <div
                key={`${comment.id}-guide-${left}`}
                data-testid="comment-tree-line"
                className={cn("absolute top-0 bottom-0 w-px", treeLineTone)}
                style={{
                  left,
                  top: -COMMENT_TREE_ROW_GAP,
                  bottom: -COMMENT_TREE_ROW_GAP,
                }}
              />
            ))}
            <div
              data-testid="comment-tree-line"
              className={cn(
                "absolute w-px",
                treeLineTone,
                isLast ? "" : "bottom-0",
              )}
              style={{
                left: (depth - 1) * COMMENT_TREE_INDENT + COMMENT_AVATAR_CENTER,
                top: -COMMENT_TREE_ROW_GAP,
                ...(isLast
                  ? {
                      height: COMMENT_TREE_ELBOW_TOP + COMMENT_TREE_ROW_GAP,
                    }
                  : {
                      bottom: -COMMENT_TREE_ROW_GAP,
                    }),
              }}
            />
            <div
              data-testid="comment-tree-line"
              className={cn("absolute h-px", treeLineTone)}
              style={{
                left: (depth - 1) * COMMENT_TREE_INDENT + COMMENT_AVATAR_CENTER,
                top: COMMENT_TREE_ELBOW_TOP,
                width: COMMENT_TREE_INDENT,
              }}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-1.5">
            {interactive && isRootThread ? (
              <CommentActionButton
                label="Delete thread"
                testId={`comment-${variant}-${comment.id}-action-delete-thread`}
                tone="danger"
                icon={<Trash2 className="size-3.5" />}
                compact
                className="absolute top-0 right-0 z-20 bg-white/80 dark:bg-slate-800/80"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteComment(comment.id);
                }}
              />
            ) : null}
            {hasReplies ? (
              <div
                aria-hidden="true"
                data-testid="comment-tree-line"
                className={cn(
                  "pointer-events-none absolute w-px",
                  treeLineTone,
                )}
                style={{
                  left: COMMENT_AVATAR_CENTER,
                  top: COMMENT_AVATAR_SIZE,
                  bottom: -COMMENT_TREE_ROW_GAP,
                }}
              />
            ) : null}
            <div className="relative flex justify-center">
              <div
                className={cn(
                  "relative z-10 flex size-5 items-center justify-center rounded-full border shadow-[0_1px_2px_rgba(15,23,42,0.08)]",
                  avatarTone,
                )}
                title={authorLabel}
              >
                <AuthorIcon className="size-2.5 shrink-0" />
              </div>
            </div>
            <div
              className={cn(
                "min-w-0 rounded-xl px-0.5",
                isRootThread && interactive && !isEditing && "pr-7",
                bodyTone,
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {authorLabel}
                </span>
                {isNew ? (
                  <span
                    data-testid={`comment-${variant}-${comment.id}-new-badge`}
                    className="shrink-0 rounded-full bg-sky-100 px-1.5 text-[10px] font-semibold leading-4 text-sky-800 dark:bg-sky-900 dark:text-sky-200"
                  >
                    New
                  </span>
                ) : null}
                {approvalState === "pending" ? (
                  <span
                    data-testid={`comment-${variant}-${comment.id}-approval-pending`}
                    title={approvalBadge.title}
                    className="shrink-0 rounded-full bg-emerald-100 px-1.5 text-[10px] font-semibold leading-4 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                  >
                    {approvalBadge.label}
                  </span>
                ) : null}
                {isResolved ? (
                  <span
                    data-testid={`comment-${variant}-${comment.id}-resolved-badge`}
                    className="shrink-0 rounded-full bg-emerald-100 px-1.5 text-[10px] font-semibold leading-4 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                  >
                    Resolved
                  </span>
                ) : null}
              </div>
              <div
                className={cn(
                  "mt-0.5 text-[13px] leading-5 whitespace-pre-wrap",
                  !hasCommentContent && "italic",
                  isCollapsedResolved && "line-clamp-2 opacity-70",
                  variant === "banner"
                    ? "text-slate-800 dark:text-slate-200"
                    : "text-slate-700 dark:text-slate-300",
                )}
              >
                {isEditing ? null : renderedContent}
              </div>
              {isResolved && comment.resolvedSummary && !isCollapsedResolved ? (
                <div
                  data-testid={`comment-${variant}-${comment.id}-resolution`}
                  className="mt-1 text-[12px] leading-4 text-emerald-800 dark:text-emerald-300"
                >
                  Resolution: {comment.resolvedSummary}
                </div>
              ) : null}
              {hiddenReplyCount > 0 ? (
                <div className="mt-1 text-[11px] leading-4 text-stone-500 dark:text-stone-400">
                  {hiddenReplyCount === 1
                    ? "1 reply"
                    : `${hiddenReplyCount} replies`}
                </div>
              ) : null}
              {isEditing ? (
                <Textarea
                  data-testid={`comment-${variant}-${comment.id}-editor`}
                  ref={(node) => {
                    if (node) {
                      textareaRefs.current.set(comment.id, node);
                    } else {
                      textareaRefs.current.delete(comment.id);
                    }
                  }}
                  value={draftContent}
                  placeholder={
                    depth === 0 ? "Add your comment" : "Write a reply"
                  }
                  rows={1}
                  className={cn(
                    "mt-2 min-h-12 px-2.5 py-2 text-[13px] leading-5 md:text-[13px] md:leading-5",
                    variant === "banner"
                      ? "border-amber-200 dark:border-amber-700 bg-white/90 dark:bg-slate-800/90 text-slate-800 dark:text-slate-200"
                      : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 shadow-none",
                  )}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onSelectComment?.(comment.id);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key.toLowerCase() === "enter"
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      onSubmitEditingComment(comment.id);
                      return;
                    }

                    if (event.key !== "Escape") return;

                    event.preventDefault();
                    event.stopPropagation();
                    onCancelEditingComment(comment.id);
                  }}
                  onFocus={() => {
                    onSelectComment?.(comment.id);
                  }}
                  onChange={(event) => {
                    onChangeDraft(comment.id, event.target.value);
                  }}
                />
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {approvalState === "confirming" ? (
                  <span
                    data-testid={`comment-${variant}-${comment.id}-approve-confirm`}
                    className="inline-flex items-center gap-0.5 rounded-full border border-emerald-200 bg-emerald-50 py-px pr-0.5 pl-2 text-[11px] font-medium tracking-[0.08em] text-emerald-700 uppercase dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400"
                  >
                    Approve
                    <CommentActionButton
                      label="Confirm approval"
                      testId={`comment-${variant}-${comment.id}-action-approve-confirm`}
                      tone="success"
                      icon={<Check className="size-3.5" />}
                      compact
                      onClick={(event) => {
                        event.stopPropagation();
                        approval.setConfirmingId(null);
                        approval.onApprove?.(comment.id);
                      }}
                    />
                    <CommentActionButton
                      label="Cancel approval"
                      testId={`comment-${variant}-${comment.id}-action-approve-cancel`}
                      icon={<X className="size-3.5" />}
                      compact
                      onClick={(event) => {
                        event.stopPropagation();
                        approval.setConfirmingId(null);
                      }}
                    />
                  </span>
                ) : null}
                {actions.map((action) => (
                  <CommentActionButton
                    key={action.key}
                    label={action.label}
                    testId={`comment-${variant}-${comment.id}-action-${action.key}`}
                    tone={action.tone}
                    presentation={action.presentation}
                    icon={action.icon}
                    compact={action.compact}
                    active={action.active}
                    onClick={action.onClick}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      {hasReplies ? (
        <div className="mt-2.5 space-y-2.5">
          {showReplyCollapse && replyCollapse ? (
            <div
              className="relative flex"
              style={{ paddingLeft: COMMENT_TREE_INDENT }}
            >
              <div
                aria-hidden="true"
                data-testid="comment-tree-line"
                className={cn(
                  "pointer-events-none absolute w-px",
                  treeLineTone,
                )}
                style={{
                  left: COMMENT_AVATAR_CENTER,
                  top: -COMMENT_TREE_ROW_GAP,
                  bottom: -COMMENT_TREE_ROW_GAP,
                }}
              />
              <CommentActionButton
                label={replyCollapseLabel}
                testId={`comment-${variant}-${comment.id}-action-${
                  replyCollapse.isExpanded ? "collapse" : "expand"
                }-replies`}
                icon={
                  replyCollapse.isExpanded ? (
                    <ChevronUp className="size-3.5" />
                  ) : (
                    <ChevronDown className="size-3.5" />
                  )
                }
                ariaExpanded={replyCollapse.isExpanded}
                onClick={(event) => {
                  event.stopPropagation();
                  replyCollapse.onToggle();
                }}
              />
            </div>
          ) : null}
          {replies.map((reply, replyIndex) => (
            <CommentThreadNode
              key={reply.comment.id}
              thread={reply}
              depth={depth + 1}
              index={replyIndex}
              isLast={replyIndex === replies.length - 1}
              parentLines={depth === 0 ? [] : [...parentLines, !isLast]}
              variant={variant}
              interactive={interactive}
              threadResolved={isInResolvedThread}
              newCommentIds={newCommentIds}
              drafts={drafts}
              newCommentDraftIds={newCommentDraftIds}
              editingCommentIds={editingCommentIds}
              pendingFocusCommentId={pendingFocusCommentId}
              selectedCommentId={selectedCommentId}
              hoveredCommentId={hoveredCommentId}
              textareaRefs={textareaRefs}
              onDeleteComment={onDeleteComment}
              onUpdateComment={onUpdateComment}
              onSelectComment={onSelectComment}
              onHoverComment={onHoverComment}
              onFocusComment={onFocusComment}
              onReplyComment={onReplyComment}
              onStartEditingComment={onStartEditingComment}
              onSubmitEditingComment={onSubmitEditingComment}
              onCancelEditingComment={onCancelEditingComment}
              renderCommentContent={renderCommentContent}
              getCommentActions={getCommentActions}
              onChangeDraft={onChangeDraft}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
