import { CheckCheck, ChevronDown, ChevronUp } from "lucide-react";
import { getNavigatorPlatform } from "./comment-shortcuts";
import { Button } from "./components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { cn } from "./lib/utils";
import {
  getReviewNavigationShortcutLabels,
  type ReviewNavigationFilter,
} from "./review-navigation";

interface ReviewNavigatorProps {
  openCount: number;
  newCount: number;
  filter: ReviewNavigationFilter;
  onFilterChange: (filter: ReviewNavigationFilter) => void;
  onNavigate: (direction: 1 | -1) => void;
  className?: string;
}

/**
 * Jump between comment threads that are still open (unresolved) or that have
 * activity since the reviewer's last "I'm done".
 */
export function ReviewNavigator({
  openCount,
  newCount,
  filter,
  onFilterChange,
  onNavigate,
  className,
}: ReviewNavigatorProps) {
  const shortcuts = getReviewNavigationShortcutLabels(getNavigatorPlatform());
  const activeCount = filter === "new" ? newCount : openCount;
  const subject = filter === "new" ? "new comment" : "open comment";
  const disabled = activeCount === 0;

  return (
    <div
      data-testid="review-navigator"
      data-comment-thread-container="true"
      className={cn(
        "flex items-center gap-1 rounded-full border border-[#E2DDD5] bg-white/95 p-1 text-xs text-stone-700 shadow-[0_10px_28px_rgba(57,47,38,0.16)] backdrop-blur dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-200",
        className,
      )}
    >
      <div className="flex items-center rounded-full bg-[#EEE9E1] p-0.5 dark:bg-slate-800">
        <button
          type="button"
          data-testid="review-navigator-filter-open"
          aria-pressed={filter === "open"}
          className={cn(
            "rounded-full px-2 py-0.5 font-medium transition",
            filter === "open"
              ? "bg-white text-stone-900 shadow-sm dark:bg-slate-600 dark:text-white"
              : "text-stone-500 hover:text-stone-800 dark:text-slate-400 dark:hover:text-slate-200",
          )}
          onClick={() => onFilterChange("open")}
        >
          {openCount} open
        </button>
        <button
          type="button"
          data-testid="review-navigator-filter-new"
          aria-pressed={filter === "new"}
          className={cn(
            "rounded-full px-2 py-0.5 font-medium transition",
            filter === "new"
              ? "bg-white text-sky-800 shadow-sm dark:bg-slate-600 dark:text-sky-200"
              : "text-stone-500 hover:text-stone-800 dark:text-slate-400 dark:hover:text-slate-200",
          )}
          onClick={() => onFilterChange("new")}
        >
          {newCount} new
        </button>
      </div>
      {openCount === 0 && filter === "open" ? (
        <span
          data-testid="review-navigator-all-resolved"
          className="flex items-center gap-1 px-1.5 text-emerald-700 dark:text-emerald-300"
        >
          <CheckCheck className="size-3.5" />
          All resolved
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="review-navigator-previous"
              aria-label={`Previous ${subject} (${shortcuts.previous})`}
              disabled={disabled}
              className="rounded-full"
              onClick={() => onNavigate(-1)}
            >
              <ChevronUp />
            </Button>
          }
        />
        <TooltipContent>
          Previous {subject} ({shortcuts.previous})
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="review-navigator-next"
              aria-label={`Next ${subject} (${shortcuts.next})`}
              disabled={disabled}
              className="rounded-full"
              onClick={() => onNavigate(1)}
            >
              <ChevronDown />
            </Button>
          }
        />
        <TooltipContent>
          Next {subject} ({shortcuts.next})
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
