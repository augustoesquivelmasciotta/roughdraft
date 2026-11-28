/**
 * Tab windows and the batch queue.
 *
 * One Roughdraft window holds a tab per review document. A new document joins
 * that window, but only at the start of a batch: while a batch is running (by
 * default 2 hours from the moment it opened) a new document waits in a queue
 * and appears with the next batch, so a review in progress is not interrupted.
 * `now` skips the queue.
 *
 * The windows are in memory, like remote document sessions (ADR 0004): a
 * window shows up on its first poll and is gone when it stops polling. The
 * queue is a separate small file (paths and times only) so a waiting document
 * survives a server restart; it is not a document model.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A window that polled in the last 10 s is live. */
export const TAB_WINDOW_LIVE_MS = 10_000;
/** A window the server just told someone to open has this long to poll first. */
export const TAB_WINDOW_PENDING_MS = 30_000;
/** How long an added tab may stay unreported before it counts as closed. */
const TAB_CONFIRM_MS = 10_000;
/** How long after a tab window last reported a path its iframe may still poll. */
const TAB_RECENT_MS = 12_000;
/** A window silent this long is forgotten. */
const WINDOW_FORGET_MS = 10 * 60_000;
const RELEASE_RETRY_MS = 60_000;
const MAX_TIMER_MS = 2_147_000_000;

export const DEFAULT_TAB_BATCH_MINUTES = 120;
export const TAB_BATCH_MINUTES_ENV = "ROUGHDRAFT_TAB_BATCH_MINUTES";
export const TAB_QUEUE_FILE = "tab-queue.json";

export interface TabInput {
  path: string;
  label?: string | null;
  since?: string | null;
}

/** Where to open a window in Orca, as the CLI that queued the tab saw it. */
export interface OrcaTargetSnapshot {
  command: string;
  worktree: string | null;
}

/** What a tab window reports for one tab on every poll. */
export interface TabState {
  path: string;
  label: string | null;
  active: boolean;
  done: boolean;
  openThreads: number;
}

export type TabCommand =
  | {
      type: "add";
      tabs: { path: string; label: string | null; since: string | null }[];
    }
  | { type: "focus"; path: string }
  | { type: "close"; path: string };

export interface QueuedTab {
  path: string;
  label: string | null;
  since: string | null;
  queuedAt: string;
  orcaTarget?: OrcaTargetSnapshot | null;
}

interface QueueFile {
  batchOpenedAt: string | null;
  queued: QueuedTab[];
}

type WindowTab = TabState & {
  since: string | null;
  addedAt: number;
  confirmed: boolean;
};

interface TabWindow {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  polled: boolean;
  tabs: WindowTab[];
  pending: TabCommand[];
}

export type TabOpenStatus =
  | "added"
  | "focused"
  | "queued"
  | "open-window"
  /** A plain single-document page shows it: the caller delivers an open request. */
  | "single-page";

export interface TabOpenResult {
  path: string;
  status: TabOpenStatus;
  releaseAt?: string;
  windowId?: string;
}

export interface TabOpenRequest {
  tabs: TabInput[];
  now?: boolean;
  windowId?: string;
  orcaTarget?: OrcaTargetSnapshot | null;
}

export interface TabOpenResponse {
  results: TabOpenResult[];
  /** Set when a window must be opened: `/tabs?window=<id>&tab=<path>…`. */
  url?: string;
  windowId?: string;
}

export interface TabReleaseResponse {
  released: number;
  /** Set when the queue went to a live window. */
  windowId?: string;
  /** Set when no window was live: the one to open. */
  url?: string;
  opened?: boolean;
}

export interface TabListing {
  windows: Array<{
    id: string;
    lastSeenAt: string;
    live: boolean;
    pending: boolean;
    tabs: TabState[];
  }>;
  queue: {
    items: QueuedTab[];
    releaseAt: string | null;
    batchOpenedAt: string | null;
  };
}

/** Opens a window for `url` (relative: `/tabs?...`); false when nothing opened. */
export type OpenTabWindow = (request: {
  url: string;
  orcaTarget: OrcaTargetSnapshot | null;
}) => Promise<boolean> | boolean;

export interface TabWindowRegistryOptions {
  /** Directory holding `tab-queue.json`. */
  stateDir: string;
  now?: () => number;
  /** Batch length in minutes; defaults to the environment, then 120. */
  batchMinutes?: number;
  env?: NodeJS.ProcessEnv;
  openWindow?: OpenTabWindow;
  /** True when a plain single-document page (not a tab window) shows the path. */
  isShownByPlainPage?: (path: string) => boolean;
  /** Schedules a callback and returns its canceller. Defaults to setTimeout. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  log?: (message: string) => void;
}

function normalizePath(value: string): string {
  return (path.isAbsolute(value) ? path.resolve(value) : value).normalize(
    "NFC",
  );
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function cleanLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 200)
    : null;
}

function cleanSince(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolveBatchMinutes(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv,
): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }
  const raw = env[TAB_BATCH_MINUTES_ENV]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TAB_BATCH_MINUTES;
}

export function buildTabWindowUrl(
  windowId: string,
  tabs: { path: string; since?: string | null }[],
): string {
  const params = new URLSearchParams();
  params.set("window", windowId);
  for (const tab of tabs) params.append("tab", tab.path);
  const first = tabs[0];
  if (first) params.set("active", first.path);
  // The page reads a tab's `since` from `since=<since>\n<path>`.
  for (const tab of tabs) {
    if (tab.since) params.append("since", `${tab.since}\n${tab.path}`);
  }
  return `/tabs?${params.toString()}`;
}

export class TabWindowRegistry {
  private readonly now: () => number;
  private readonly batchMs: number;
  private readonly queueFile: string;
  private readonly openWindow: OpenTabWindow | null;
  private readonly isShownByPlainPage: (path: string) => boolean;
  private readonly schedule: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  private readonly log: (message: string) => void;
  private readonly windows = new Map<string, TabWindow>();
  /** Normalized path to the last time a tab window reported it. */
  private readonly lastHeld = new Map<string, number>();
  private batchOpenedAt: number | null = null;
  private queued: QueuedTab[] = [];
  private cancelTimer: (() => void) | null = null;

  constructor(options: TabWindowRegistryOptions) {
    this.now = options.now ?? (() => Date.now());
    this.batchMs =
      resolveBatchMinutes(options.batchMinutes, options.env ?? process.env) *
      60_000;
    this.queueFile = path.join(options.stateDir, TAB_QUEUE_FILE);
    this.openWindow = options.openWindow ?? null;
    this.isShownByPlainPage = options.isShownByPlainPage ?? (() => false);
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.log = options.log ?? ((message) => console.error(message));
  }

  /** Reads the queue file and re-arms the release timer. Call once at server start. */
  restore(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.queueFile, "utf8"),
      ) as Partial<QueueFile>;
      const batchOpenedAt =
        typeof parsed.batchOpenedAt === "string"
          ? Date.parse(parsed.batchOpenedAt)
          : Number.NaN;
      this.batchOpenedAt = Number.isFinite(batchOpenedAt)
        ? batchOpenedAt
        : null;
      this.queued = Array.isArray(parsed.queued)
        ? parsed.queued.flatMap((item): QueuedTab[] =>
            item && typeof item.path === "string" && item.path
              ? [
                  {
                    path: item.path,
                    label: cleanLabel(item.label),
                    since: cleanSince(item.since),
                    queuedAt:
                      typeof item.queuedAt === "string"
                        ? item.queuedAt
                        : new Date(this.now()).toISOString(),
                    ...(item.orcaTarget ? { orcaTarget: item.orcaTarget } : {}),
                  },
                ]
              : [],
          )
        : [];
    } catch {
      this.batchOpenedAt = null;
      this.queued = [];
    }
    this.arm();
  }

  dispose(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /** True when a tab window showed the path in the last few seconds. */
  recentlyHeld(targetPath: string): boolean {
    const seen = this.lastHeld.get(normalizePath(targetPath));
    return seen !== undefined && this.now() - seen <= TAB_RECENT_MS;
  }

  open(request: TabOpenRequest): TabOpenResponse {
    const now = this.now();

    const inputs = new Map<string, TabInput>();
    for (const tab of request.tabs) {
      if (typeof tab.path !== "string" || !tab.path.trim()) continue;
      inputs.set(normalizePath(tab.path.trim()), {
        path: tab.path.trim(),
        label: cleanLabel(tab.label),
        since: cleanSince(tab.since),
      });
    }

    const forceNow = request.now === true;
    const batchIdle = this.batchIsIdle(now);
    let queueChanged = false;
    if (batchIdle && this.queued.length > 0) {
      // The next batch is due and its timer has not fired yet: what waited
      // opens together with this request.
      for (const item of this.queued) {
        const key = normalizePath(item.path);
        if (!inputs.has(key)) {
          inputs.set(key, {
            path: item.path,
            label: item.label,
            since: item.since,
          });
        }
      }
      this.queued = [];
      queueChanged = true;
    }
    // One request is one review set: it opens together or waits together.
    const immediate = forceNow || batchIdle;
    const orcaTarget = request.orcaTarget ?? null;

    const resultByPath = new Map<string, TabOpenResult>();
    const toAdd: {
      path: string;
      label: string | null;
      since: string | null;
    }[] = [];

    for (const tab of inputs.values()) {
      const holder = this.findHolder(tab.path, now);
      if (holder) {
        holder.pending.push({ type: "focus", path: tab.path });
        resultByPath.set(normalizePath(tab.path), {
          path: tab.path,
          status: "focused",
          windowId: holder.id,
        });
        continue;
      }

      const queuedIndex = this.queued.findIndex((item) =>
        samePath(item.path, tab.path),
      );
      if (queuedIndex >= 0 && !forceNow) {
        const item = this.queued[queuedIndex] as QueuedTab;
        item.label = tab.label ?? item.label;
        item.since = tab.since ?? item.since;
        if (orcaTarget) item.orcaTarget = orcaTarget;
        queueChanged = true;
        resultByPath.set(normalizePath(tab.path), {
          path: tab.path,
          status: "queued",
          releaseAt: this.releaseAtIso() ?? undefined,
        });
        continue;
      }

      if (this.isShownByPlainPage(tab.path) && !this.recentlyHeld(tab.path)) {
        resultByPath.set(normalizePath(tab.path), {
          path: tab.path,
          status: "single-page",
        });
        continue;
      }

      if (queuedIndex >= 0) {
        this.queued.splice(queuedIndex, 1);
        queueChanged = true;
      }

      if (!immediate) {
        this.queued.push({
          path: tab.path,
          label: tab.label ?? null,
          since: tab.since ?? null,
          queuedAt: new Date(now).toISOString(),
          ...(orcaTarget ? { orcaTarget } : {}),
        });
        queueChanged = true;
        resultByPath.set(normalizePath(tab.path), {
          path: tab.path,
          status: "queued",
          releaseAt: this.releaseAtIso() ?? undefined,
        });
        continue;
      }

      toAdd.push({
        path: tab.path,
        label: tab.label ?? null,
        since: tab.since ?? null,
      });
    }

    let delivered: { windowId?: string; url?: string } = {};
    if (toAdd.length > 0) {
      // A `now` open leaves the batch clock alone; an open that starts a
      // batch sets it.
      if (!forceNow && batchIdle) {
        this.batchOpenedAt = now;
        queueChanged = true;
      }
      const delivery = this.deliver(toAdd, request.windowId, now);
      for (const tab of toAdd) {
        resultByPath.set(normalizePath(tab.path), {
          path: tab.path,
          status: delivery.url ? "open-window" : "added",
          windowId: delivery.windowId,
        });
      }
      delivered = delivery;
    }
    const results = [...inputs.keys()].flatMap((key) => {
      const result = resultByPath.get(key);
      return result ? [result] : [];
    });
    const response: TabOpenResponse = { results, ...delivered };

    if (queueChanged) this.persistAndArm();
    return response;
  }

  /** The poll of one tab window: what its tabs look like now, and what to do. */
  poll(
    windowId: string,
    reported: TabState[],
  ): {
    commands: TabCommand[];
    queue: { count: number; releaseAt: string | null };
  } {
    const now = this.now();

    let window = this.windows.get(windowId);
    if (!window) {
      window = {
        id: windowId,
        createdAt: now,
        lastSeenAt: now,
        polled: true,
        tabs: [],
        pending: [],
      };
      this.windows.set(windowId, window);
    }
    window.lastSeenAt = now;
    window.polled = true;

    const previous = window.tabs;
    const next: WindowTab[] = [];
    for (const tab of reported) {
      if (typeof tab?.path !== "string" || !tab.path) continue;
      const before = previous.find((entry) => samePath(entry.path, tab.path));
      next.push({
        path: tab.path,
        label: cleanLabel(tab.label) ?? before?.label ?? null,
        active: tab.active === true,
        done: tab.done === true,
        openThreads: typeof tab.openThreads === "number" ? tab.openThreads : 0,
        since: before?.since ?? null,
        addedAt: before?.addedAt ?? now,
        confirmed: true,
      });
      this.lastHeld.set(normalizePath(tab.path), now);
    }
    // A tab added by command the page has not reported yet is still coming. A
    // confirmed tab that stops being reported was finished or closed.
    for (const tab of previous) {
      if (next.some((entry) => samePath(entry.path, tab.path))) continue;
      if (!tab.confirmed && now - tab.addedAt < TAB_CONFIRM_MS) next.push(tab);
    }
    window.tabs = next;
    this.pruneWindows(now);

    const commands = window.pending;
    window.pending = [];
    return { commands, queue: this.queueState() };
  }

  focus(
    targetPath: string,
    windowId?: string,
  ): { focused: boolean; windowId?: string } {
    const now = this.now();
    const window = windowId
      ? this.liveWindow(windowId, now)
      : this.findHolder(targetPath, now);
    if (!window?.tabs.some((tab) => samePath(tab.path, targetPath))) {
      return { focused: false };
    }
    window.pending.push({ type: "focus", path: targetPath });
    return { focused: true, windowId: window.id };
  }

  /** Closes a tab of a window, or drops the document from the queue. */
  close(
    targetPath: string,
    windowId?: string,
  ): { closed: boolean; from?: "window" | "queue"; windowId?: string } {
    const now = this.now();
    const window = windowId
      ? this.liveWindow(windowId, now)
      : this.findHolder(targetPath, now);
    if (window?.tabs.some((tab) => samePath(tab.path, targetPath))) {
      window.pending.push({ type: "close", path: targetPath });
      return { closed: true, from: "window", windowId: window.id };
    }
    const queuedIndex = this.queued.findIndex((item) =>
      samePath(item.path, targetPath),
    );
    if (queuedIndex >= 0 && !windowId) {
      this.queued.splice(queuedIndex, 1);
      this.persistAndArm();
      return { closed: true, from: "queue" };
    }
    return { closed: false };
  }

  /**
   * Opens the next batch now: the queued documents go to the live window as
   * add commands, or into a new window. A new window is opened by the server
   * only when `open` is true; otherwise its URL is returned for the caller.
   */
  async release(options: { open?: boolean } = {}): Promise<TabReleaseResponse> {
    const now = this.now();
    if (this.queued.length === 0) return { released: 0 };

    const items = this.queued;
    const previousBatch = this.batchOpenedAt;
    this.queued = [];
    this.batchOpenedAt = now;
    this.persistAndArm();

    const delivery = this.deliver(
      items.map((item) => ({
        path: item.path,
        label: item.label,
        since: item.since,
      })),
      undefined,
      now,
    );
    if (!delivery.url) {
      return { released: items.length, windowId: delivery.windowId };
    }

    if (!options.open) {
      return {
        released: items.length,
        windowId: delivery.windowId,
        url: delivery.url,
      };
    }

    const orcaTarget =
      [...items].reverse().find((item) => item.orcaTarget)?.orcaTarget ?? null;
    let opened = false;
    try {
      opened = this.openWindow
        ? await this.openWindow({ url: delivery.url, orcaTarget })
        : false;
    } catch (error) {
      this.log(
        `Roughdraft could not open the tab window: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!opened) {
      // Nothing is showing: forget the window and keep the documents queued,
      // so the next try is not a silent loss (#22).
      this.windows.delete(delivery.windowId);
      this.queued = items;
      this.batchOpenedAt = previousBatch;
      this.persist();
      this.cancelTimer?.();
      this.cancelTimer = this.schedule(
        () => void this.release({ open: true }),
        RELEASE_RETRY_MS,
      );
      return { released: 0, opened: false };
    }
    return {
      released: items.length,
      windowId: delivery.windowId,
      url: delivery.url,
      opened: true,
    };
  }

  list(): TabListing {
    const now = this.now();
    return {
      windows: [...this.windows.values()]
        .filter((window) => now - window.lastSeenAt <= WINDOW_FORGET_MS)
        .map((window) => ({
          id: window.id,
          lastSeenAt: new Date(window.lastSeenAt).toISOString(),
          live: this.isLive(window, now),
          pending: !window.polled,
          tabs: window.tabs.map(
            ({ path: tabPath, label, active, done, openThreads }) => ({
              path: tabPath,
              label,
              active,
              done,
              openThreads,
            }),
          ),
        })),
      queue: {
        items: this.queued.map((item) => ({ ...item })),
        releaseAt: this.releaseAtIso(),
        batchOpenedAt:
          this.batchOpenedAt === null
            ? null
            : new Date(this.batchOpenedAt).toISOString(),
      },
    };
  }

  queueState(): { count: number; releaseAt: string | null } {
    return { count: this.queued.length, releaseAt: this.releaseAtIso() };
  }

  // --- internals ---

  private isLive(window: TabWindow, now: number): boolean {
    return window.polled
      ? now - window.lastSeenAt <= TAB_WINDOW_LIVE_MS
      : now - window.createdAt <= TAB_WINDOW_PENDING_MS;
  }

  private liveWindow(id: string, now: number): TabWindow | null {
    const window = this.windows.get(id);
    return window && this.isLive(window, now) ? window : null;
  }

  private newestLiveWindow(now: number): TabWindow | null {
    let best: TabWindow | null = null;
    for (const window of this.windows.values()) {
      if (!this.isLive(window, now)) continue;
      if (!best || window.lastSeenAt >= best.lastSeenAt) best = window;
    }
    return best;
  }

  private findHolder(targetPath: string, now: number): TabWindow | null {
    let best: TabWindow | null = null;
    for (const window of this.windows.values()) {
      if (!this.isLive(window, now)) continue;
      if (!window.tabs.some((tab) => samePath(tab.path, targetPath))) continue;
      if (!best || window.lastSeenAt >= best.lastSeenAt) best = window;
    }
    return best;
  }

  private batchIsIdle(now: number): boolean {
    return (
      this.batchOpenedAt === null || now - this.batchOpenedAt >= this.batchMs
    );
  }

  private releaseAtMs(): number | null {
    if (this.batchOpenedAt === null) return null;
    return this.batchOpenedAt + this.batchMs;
  }

  private releaseAtIso(): string | null {
    const at = this.releaseAtMs();
    return at === null ? null : new Date(at).toISOString();
  }

  /** Adds tabs to the live window, or makes a new window to hold them. */
  private deliver(
    tabs: { path: string; label: string | null; since: string | null }[],
    windowId: string | undefined,
    now: number,
  ): { windowId: string; url?: string } {
    const live = windowId
      ? this.liveWindow(windowId, now)
      : this.newestLiveWindow(now);
    const entries: WindowTab[] = tabs.map((tab) => ({
      path: tab.path,
      label: tab.label,
      since: tab.since,
      active: false,
      done: false,
      openThreads: 0,
      addedAt: now,
      confirmed: false,
    }));

    if (live) {
      live.tabs.push(...entries);
      live.pending.push({
        type: "add",
        tabs: tabs.map((tab) => ({ ...tab })),
      });
      return { windowId: live.id };
    }

    const id = windowId || crypto.randomUUID();
    // The page loads its tabs from the URL; the window counts as live while
    // it loads, so a second open in that time joins it instead of opening
    // another.
    this.windows.set(id, {
      id,
      createdAt: now,
      lastSeenAt: now,
      polled: false,
      tabs: entries,
      pending: [],
    });
    for (const tab of tabs) this.lastHeld.set(normalizePath(tab.path), now);
    return { windowId: id, url: buildTabWindowUrl(id, tabs) };
  }

  private pruneWindows(now: number): void {
    for (const [id, window] of this.windows) {
      if (now - window.lastSeenAt > WINDOW_FORGET_MS) this.windows.delete(id);
    }
    for (const [key, seen] of this.lastHeld) {
      if (now - seen > WINDOW_FORGET_MS) this.lastHeld.delete(key);
    }
  }

  private persistAndArm(): void {
    this.persist();
    this.arm();
  }

  private persist(): void {
    const body: QueueFile = {
      batchOpenedAt:
        this.batchOpenedAt === null
          ? null
          : new Date(this.batchOpenedAt).toISOString(),
      queued: this.queued,
    };
    const temp = `${this.queueFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.queueFile), { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`);
      fs.renameSync(temp, this.queueFile);
    } catch (error) {
      this.log(
        `Roughdraft could not save the tab queue: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    const at = this.releaseAtMs();
    if (this.queued.length === 0 || at === null) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - this.now()));
    this.cancelTimer = this.schedule(
      () => void this.release({ open: true }),
      delay,
    );
  }
}
