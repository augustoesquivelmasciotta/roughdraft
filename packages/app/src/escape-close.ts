/**
 * Escape closes the open review panel (the selected thread, in the rail or in
 * the narrow-screen sheet). Anything that handles Escape itself runs first and
 * marks the event as handled (`preventDefault`): Radix popovers and dialogs,
 * the editor context menu, the link popover. Those are closed innermost first
 * and this one is left for the next press.
 */
export function shouldEscapeCloseReviewPanel(
  event: Pick<KeyboardEvent, "key" | "defaultPrevented" | "isComposing"> & {
    target: EventTarget | null;
  },
): boolean {
  if (event.key !== "Escape") return false;
  if (event.defaultPrevented || event.isComposing) return false;

  // A comment or suggestion being typed has its own Escape (cancel with its
  // safeguards); this handler never discards what is in a text field.
  const target = event.target;
  if (
    typeof HTMLElement !== "undefined" &&
    target instanceof HTMLElement &&
    target.closest("textarea, input, select")
  ) {
    return false;
  }
  return true;
}
