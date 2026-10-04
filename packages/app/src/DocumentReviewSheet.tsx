import { X } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { Button } from "./components/ui/button";

/**
 * Below 900px (a phone in Orca mobile, a narrow split pane) there is no room
 * for the review rail beside the document. The selected thread opens in this
 * panel over the bottom of the page instead, with the review navigator to
 * step to the next one. Tapping a highlight opens it; closing it, or tapping
 * plain text, clears the selection.
 */
export const DocumentReviewSheet = forwardRef<
  HTMLElement,
  {
    navigator: ReactNode;
    onClose: () => void;
    children: ReactNode;
  }
>(function DocumentReviewSheet({ navigator, onClose, children }, ref) {
  return (
    <section
      ref={ref}
      data-testid="document-review-sheet"
      // Why: a tap anywhere in the panel must not count as a tap outside the
      // thread, which would close it.
      data-comment-thread-container="true"
      aria-label="Selected review thread"
      className="fixed inset-x-0 bottom-0 z-[56] flex max-h-[min(55vh,32rem)] flex-col rounded-t-2xl border-t border-[#E2DDD5] bg-[#FBFAF8]/95 shadow-[0_-16px_44px_rgba(57,47,38,0.16)] backdrop-blur dark:border-slate-700 dark:bg-slate-900/95 dark:shadow-[0_-16px_44px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
        {navigator}
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          data-testid="document-review-sheet-close"
          aria-label="Close"
          className="rounded-full"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {children}
      </div>
    </section>
  );
});
