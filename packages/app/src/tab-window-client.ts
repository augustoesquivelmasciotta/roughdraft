/** What a tab window tells the server about one of its tabs, on every poll. */
export interface TabWindowTabState {
  path: string;
  label: string | null;
  active: boolean;
  done: boolean;
  openThreads: number;
}

export type TabWindowCommand =
  | {
      type: "add";
      tabs: { path: string; label?: string | null; since?: string | null }[];
    }
  | { type: "focus"; path: string }
  | { type: "close"; path: string };

export interface TabWindowQueueState {
  count: number;
  releaseAt: string | null;
}

export interface TabWindowPollResult {
  commands: TabWindowCommand[];
  queue: TabWindowQueueState;
}

export const TAB_WINDOW_POLL_INTERVAL_MS = 1500;

/** `POST /api/tab-windows/poll`: reports the window's tabs, receives commands. */
export async function pollTabWindow(
  windowId: string,
  tabs: TabWindowTabState[],
): Promise<TabWindowPollResult> {
  const res = await fetch("/api/tab-windows/poll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ windowId, tabs }),
  });
  if (!res.ok) throw new Error(`Tab window poll failed: ${res.status}`);

  const payload = (await res.json()) as {
    commands?: unknown;
    queue?: { count?: unknown; releaseAt?: unknown } | null;
  };
  const commands = Array.isArray(payload.commands)
    ? (payload.commands as TabWindowCommand[]).filter(isTabWindowCommand)
    : [];
  return {
    commands,
    queue: {
      count: typeof payload.queue?.count === "number" ? payload.queue.count : 0,
      releaseAt:
        typeof payload.queue?.releaseAt === "string"
          ? payload.queue.releaseAt
          : null,
    },
  };
}

function isTabWindowCommand(value: unknown): value is TabWindowCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  if (command.type === "add") return Array.isArray(command.tabs);
  return (
    (command.type === "focus" || command.type === "close") &&
    typeof command.path === "string"
  );
}
