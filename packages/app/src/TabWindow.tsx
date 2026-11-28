import { Check, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { closeOrcaTabOnServer } from "./api-backend";
import { getPathLeaf, TAB_WINDOW_PATH } from "./app-navigation";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import {
  REVIEW_DELIVERED_MESSAGE,
  readTabMessage,
  TAB_STATE_MESSAGE,
} from "./tab-protocol";
import {
  pollTabWindow,
  TAB_WINDOW_POLL_INTERVAL_MS,
  type TabWindowCommand,
} from "./tab-window-client";

/** How long a finished tab shows its check mark before it goes away. */
export const TAB_DONE_LINGER_MS = 1200;

interface TabEntry {
  path: string;
  label: string | null;
  /** What to compare this document against; null means the last review. */
  since: string | null;
  done: boolean;
  openThreads: number;
}

interface TabWindowLocationState {
  windowId: string;
  paths: string[];
  active: string | null;
  /** Optional `since` per tab path. */
  sinceByPath?: Record<string, string>;
}

/** The tab window's URL carries a tab's `since` as `since=<since>\n<path>`. */
const SINCE_PARAM_SEPARATOR = "\n";

export function readTabWindowLocation(search: string): TabWindowLocationState {
  const params = new URLSearchParams(search);
  const paths = [
    ...new Set(
      params
        .getAll("tab")
        .map((path) => path.trim())
        .filter(Boolean),
    ),
  ];
  const requestedActive = params.get("active")?.trim() || null;
  const sinceByPath: Record<string, string> = {};
  for (const value of params.getAll("since")) {
    const at = value.indexOf(SINCE_PARAM_SEPARATOR);
    if (at <= 0) continue;
    const since = value.slice(0, at).trim();
    const path = value.slice(at + 1).trim();
    if (since && path && paths.includes(path)) sinceByPath[path] = since;
  }
  return {
    windowId:
      params.get("window")?.trim() ||
      globalThis.crypto?.randomUUID?.() ||
      `window-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    paths,
    active:
      requestedActive && paths.includes(requestedActive)
        ? requestedActive
        : (paths[0] ?? null),
    sinceByPath: Object.keys(sinceByPath).length > 0 ? sinceByPath : undefined,
  };
}

export function buildTabWindowLocation({
  windowId,
  paths,
  active,
  sinceByPath = {},
}: TabWindowLocationState) {
  const params = new URLSearchParams();
  params.set("window", windowId);
  for (const path of paths) params.append("tab", path);
  if (active) params.set("active", active);
  for (const path of paths) {
    const since = sinceByPath[path];
    if (since)
      params.append("since", `${since}${SINCE_PARAM_SEPARATOR}${path}`);
  }
  return `${TAB_WINDOW_PATH}?${params.toString()}`;
}

export function buildTabFrameUrl(
  path: string,
  label: string | null,
  since: string | null = null,
) {
  const params = new URLSearchParams();
  params.set("path", path);
  if (label) params.set("label", label);
  if (since) params.set("since", since);
  params.set("embedded", "1");
  return `/?${params.toString()}`;
}

function nextUnfinishedPath(tabs: TabEntry[], fromPath: string | null) {
  if (tabs.length === 0) return null;
  const start = Math.max(
    0,
    tabs.findIndex((tab) => tab.path === fromPath),
  );
  for (let offset = 1; offset <= tabs.length; offset += 1) {
    const candidate = tabs[(start + offset) % tabs.length];
    if (candidate && !candidate.done) return candidate.path;
  }
  return null;
}

export function TabWindow() {
  const [initial] = useState(() =>
    readTabWindowLocation(window.location.search),
  );
  const [tabs, setTabs] = useState<TabEntry[]>(() =>
    initial.paths.map((path) => ({
      path,
      label: null,
      since: initial.sinceByPath?.[path] ?? null,
      done: false,
      openThreads: 0,
    })),
  );
  const [activePath, setActivePath] = useState<string | null>(initial.active);
  // An iframe is created the first time its tab comes forward and then stays
  // mounted while hidden, so switching tabs never loses an edit.
  const [activated, setActivated] = useState<string[]>(
    initial.active ? [initial.active] : [],
  );
  const [closeFailed, setCloseFailed] = useState(false);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const hadTabsRef = useRef(tabs.length > 0);
  const lingerTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const activate = useCallback((path: string) => {
    setActivePath(path);
    setActivated((current) =>
      current.includes(path) ? current : [...current, path],
    );
  }, []);

  const removeTab = useCallback((path: string, _finished: boolean) => {
    const remaining = tabsRef.current.filter((tab) => tab.path !== path);
    tabsRef.current = remaining;
    setTabs(remaining);
    setActivated((current) => current.filter((item) => item !== path));
    if (activePathRef.current === path) {
      const next =
        nextUnfinishedPath(tabsRef.current, path) ?? remaining[0]?.path ?? null;
      setActivePath(next);
      if (next) {
        setActivated((current) =>
          current.includes(next) ? current : [...current, next],
        );
      }
    }
  }, []);

  const handleDelivered = useCallback(
    (path: string) => {
      if (!tabsRef.current.some((tab) => tab.path === path)) return;
      const next = nextUnfinishedPath(
        tabsRef.current.map((tab) =>
          tab.path === path ? { ...tab, done: true } : tab,
        ),
        path,
      );
      setTabs((current) =>
        current.map((tab) =>
          tab.path === path ? { ...tab, done: true } : tab,
        ),
      );
      if (next && activePathRef.current === path) activate(next);

      const timer = setTimeout(() => {
        lingerTimersRef.current.delete(timer);
        removeTab(path, true);
      }, TAB_DONE_LINGER_MS);
      lingerTimersRef.current.add(timer);
    },
    [activate, removeTab],
  );

  const applyCommands = useCallback(
    (commands: TabWindowCommand[]) => {
      for (const command of commands) {
        if (command.type === "add") {
          const fresh = command.tabs.filter(
            (tab) =>
              tab.path &&
              !tabsRef.current.some((existing) => existing.path === tab.path),
          );
          if (fresh.length === 0) continue;
          const entries = fresh.map((tab) => ({
            path: tab.path,
            label: tab.label ?? null,
            since: tab.since?.trim() || null,
            done: false,
            openThreads: 0,
          }));
          tabsRef.current = [...tabsRef.current, ...entries];
          setTabs(tabsRef.current);
          const first = entries[0];
          if (first && !activePathRef.current) activate(first.path);
        } else if (command.type === "focus") {
          if (tabsRef.current.some((tab) => tab.path === command.path)) {
            activate(command.path);
          }
        } else if (command.type === "close") {
          if (tabsRef.current.some((tab) => tab.path === command.path)) {
            removeTab(command.path, false);
          }
        }
      }
    },
    [activate, removeTab],
  );

  // Poll the server: report the tabs, apply the commands it hands back.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const result = await pollTabWindow(
          initial.windowId,
          tabsRef.current.map((tab) => ({
            path: tab.path,
            label: tab.label,
            active: tab.path === activePathRef.current,
            done: tab.done,
            openThreads: tab.openThreads,
          })),
        );
        if (!stopped) {
          applyCommands(result.commands);
        }
      } catch (error) {
        console.error("Failed to poll the Roughdraft tab window:", error);
      }
      if (!stopped) timer = setTimeout(poll, TAB_WINDOW_POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [applyCommands, initial.windowId]);

  // Messages from the documents' iframes.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = readTabMessage(event);
      if (!message) return;
      if (message.type === TAB_STATE_MESSAGE) {
        setTabs((current) =>
          current.map((tab) =>
            tab.path === message.path
              ? { ...tab, openThreads: message.openThreads }
              : tab,
          ),
        );
      } else if (message.type === REVIEW_DELIVERED_MESSAGE) {
        handleDelivered(message.path);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleDelivered]);

  // Keep the URL in step, so a reload or a server restart shows the same tabs.
  useEffect(() => {
    const nextLocation = buildTabWindowLocation({
      windowId: initial.windowId,
      paths: tabs.map((tab) => tab.path),
      active: activePath,
      sinceByPath: Object.fromEntries(
        tabs.flatMap((tab) => (tab.since ? [[tab.path, tab.since]] : [])),
      ),
    });
    const currentLocation = `${window.location.pathname}${window.location.search}`;
    if (nextLocation !== currentLocation) {
      window.history.replaceState(window.history.state, "", nextLocation);
    }
  }, [activePath, initial.windowId, tabs]);

  useEffect(() => {
    document.title = "Roughdraft reviews";
  }, []);

  useEffect(() => {
    const timers = lingerTimersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // The window closes itself, like a single-document page does, once its last
  // tab is gone.
  useEffect(() => {
    if (tabs.length > 0) {
      hadTabsRef.current = true;
      return;
    }
    if (!hadTabsRef.current) return;

    let cancelled = false;
    void (async () => {
      window.close();
      // An Orca browser tab ignores window.close(): ask the server to close it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const closed = await closeOrcaTabOnServer(window.location.href).catch(
        () => false,
      );
      if (!closed && !cancelled) setCloseFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [tabs.length]);

  return (
    <main
      data-testid="tab-window"
      className="flex h-screen min-w-0 flex-col overflow-hidden bg-[#FCFCFC] text-slate-950 dark:bg-background dark:text-slate-50"
    >
      <div
        data-testid="tab-window-strip"
        role="tablist"
        aria-label="Documents under review"
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-stone-200 bg-stone-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900"
      >
        {tabs.map((tab) => {
          const isActive = tab.path === activePath;
          const name = getPathLeaf(tab.path) ?? tab.path;
          return (
            <div
              key={tab.path}
              className={cn(
                "flex min-w-0 max-w-64 shrink-0 items-center gap-1 rounded-[7px] border border-transparent pl-2.5 pr-1 text-sm",
                isActive
                  ? "border-stone-300 bg-white text-stone-950 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-50"
                  : "text-stone-600 hover:bg-stone-100 dark:text-slate-300 dark:hover:bg-slate-800/60",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                title={tab.path}
                data-testid={`tab-window-tab-${tab.path}`}
                data-active={isActive ? "true" : "false"}
                className="flex min-w-0 items-center gap-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-950/25 dark:focus-visible:ring-slate-50/30"
                onClick={() => activate(tab.path)}
              >
                <span className="truncate">{name}</span>
                {tab.done ? (
                  <Check
                    data-testid={`tab-window-done-${tab.path}`}
                    aria-label="Review delivered"
                    className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                  />
                ) : tab.openThreads > 0 ? (
                  <span
                    data-testid={`tab-window-open-${tab.path}`}
                    role="img"
                    aria-label={`${tab.openThreads} open threads`}
                    className="size-1.5 shrink-0 rounded-full bg-amber-500"
                  />
                ) : null}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Close ${name}`}
                data-testid={`tab-window-close-${tab.path}`}
                onClick={() => removeTab(tab.path, false)}
              >
                <X />
              </Button>
            </div>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div
            data-testid="tab-window-empty"
            className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500 dark:text-slate-400"
          >
            {closeFailed
              ? "All reviews are done. Close this tab from the tab bar."
              : "Waiting for documents to review."}
          </div>
        ) : null}
        {tabs
          .filter((tab) => activated.includes(tab.path))
          .map((tab) => (
            <iframe
              key={tab.path}
              data-testid={`tab-window-frame-${tab.path}`}
              title={getPathLeaf(tab.path) ?? tab.path}
              src={buildTabFrameUrl(tab.path, tab.label, tab.since)}
              className={cn(
                "absolute inset-0 size-full border-0",
                tab.path !== activePath && "hidden",
              )}
            />
          ))}
      </div>
    </main>
  );
}
