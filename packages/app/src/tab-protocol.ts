/**
 * The same-origin postMessage protocol between a tab window (the parent) and
 * the single-document pages it shows in iframes (the children).
 */
export const TAB_STATE_MESSAGE = "roughdraft:tab-state";
export const REVIEW_DELIVERED_MESSAGE = "roughdraft:review-delivered";

export interface TabStateMessage {
  type: typeof TAB_STATE_MESSAGE;
  path: string;
  openThreads: number;
}

export interface ReviewDeliveredMessage {
  type: typeof REVIEW_DELIVERED_MESSAGE;
  path: string;
}

export type TabMessage = TabStateMessage | ReviewDeliveredMessage;

/** Narrows a received message; ignores anything not from this origin. */
export function readTabMessage(event: MessageEvent): TabMessage | null {
  if (event.origin !== window.location.origin) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || typeof data.path !== "string") {
    return null;
  }
  if (
    data.type === TAB_STATE_MESSAGE &&
    typeof data.openThreads === "number"
  ) {
    return {
      type: TAB_STATE_MESSAGE,
      path: data.path,
      openThreads: data.openThreads,
    };
  }
  if (data.type === REVIEW_DELIVERED_MESSAGE) {
    return { type: REVIEW_DELIVERED_MESSAGE, path: data.path };
  }
  return null;
}

/** The `embedded=1` flag a tab window puts on its iframes' URLs. */
export function isEmbeddedInTabWindow(): boolean {
  try {
    return (
      new URLSearchParams(window.location.search).get("embedded") === "1" &&
      window.parent !== window
    );
  } catch {
    return false;
  }
}

/** The tab identity of this page: the `path` value of its URL. */
export function getTabPathFromLocation(): string | null {
  return (
    new URLSearchParams(window.location.search).get("path")?.trim() || null
  );
}

export function postToTabWindow(message: TabMessage) {
  try {
    window.parent.postMessage(message, window.location.origin);
  } catch (error) {
    console.error("Failed to post to the tab window:", error);
  }
}
