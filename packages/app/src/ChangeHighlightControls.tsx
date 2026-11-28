import { ChevronDown, ChevronUp, Highlighter } from "lucide-react";
import { Button } from "./components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { cn } from "./lib/utils";
import type { ChangeHighlightView } from "./use-change-highlight";

/**
 * The "Changes" toggle with its count and next/previous jump. Hidden when
 * there is nothing to show: no baseline, or the document equals it.
 */
export function ChangeHighlightControls({
  view,
  onToggle,
  onNext,
  onPrevious,
}: {
  view: ChangeHighlightView;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
}) {
  if (view.count === 0) return null;

  const countLabel = `${view.count} ${view.count === 1 ? "change" : "changes"}`;
  const position =
    view.currentIndex === null
      ? countLabel
      : `${view.currentIndex + 1} of ${countLabel}`;
  const baseline = view.baselineLabel
    ? `Compared with ${view.baselineLabel}`
    : "Compared with the last review";

  return (
    <div
      data-testid="change-highlight-controls"
      className="inline-flex h-[1.25rem] shrink-0 items-center gap-0.5"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="change-highlight-toggle"
              aria-pressed={view.visible}
              aria-label={view.visible ? "Hide changes" : "Show changes"}
              className={cn(
                "gap-1 px-1.5 text-[0.8rem] font-medium tracking-[0.01em]",
                view.visible
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-stone-400 dark:text-slate-400",
              )}
              onClick={onToggle}
            />
          }
        >
          <Highlighter className="size-[0.8rem]" aria-hidden="true" />
          <span>Changes</span>
        </TooltipTrigger>
        <TooltipContent>{baseline}</TooltipContent>
      </Tooltip>
      <span
        data-testid="change-highlight-count"
        className="px-0.5 text-[0.75rem] text-stone-400 tabular-nums dark:text-slate-500"
      >
        {position}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="change-highlight-previous"
        aria-label="Previous change"
        className="text-stone-400 dark:text-slate-400"
        onClick={onPrevious}
      >
        <ChevronUp aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="change-highlight-next"
        aria-label="Next change"
        className="text-stone-400 dark:text-slate-400"
        onClick={onNext}
      >
        <ChevronDown aria-hidden="true" />
      </Button>
    </div>
  );
}
