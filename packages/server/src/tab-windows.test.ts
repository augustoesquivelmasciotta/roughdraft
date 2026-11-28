import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTabWindowUrl,
  type OpenTabWindow,
  TabWindowRegistry,
  type TabWindowRegistryOptions,
} from "./tab-windows";

const MINUTE = 60_000;
const START = Date.parse("2026-11-28T10:00:00.000Z");

describe("TabWindowRegistry", () => {
  let stateDir: string;
  let clock: number;
  let timers: Array<{ callback: () => void; delayMs: number; live: boolean }>;
  let opened: Array<{ url: string; orcaTarget: unknown }>;
  let openResult: boolean;

  const openWindow: OpenTabWindow = (request) => {
    opened.push(request);
    return openResult;
  };

  function make(overrides: Partial<TabWindowRegistryOptions> = {}) {
    return new TabWindowRegistry({
      stateDir,
      now: () => clock,
      env: {},
      openWindow,
      schedule: (callback, delayMs) => {
        const timer = { callback, delayMs, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
      log: () => {},
      ...overrides,
    });
  }

  function tabState(tabPath: string, extra = {}) {
    return {
      path: tabPath,
      label: null,
      active: false,
      done: false,
      openThreads: 0,
      ...extra,
    };
  }

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-tabs-"));
    clock = START;
    timers = [];
    opened = [];
    openResult = true;
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("opens the first document at once, in a new window, and starts a batch", () => {
    const registry = make();

    const response = registry.open({ tabs: [{ path: "/docs/a.md" }] });

    expect(response.results).toEqual([
      { path: "/docs/a.md", status: "open-window", windowId: response.windowId },
    ]);
    expect(response.url).toBe(
      buildTabWindowUrl(response.windowId as string, [{ path: "/docs/a.md" }]),
    );
    expect(response.url).toContain("tab=%2Fdocs%2Fa.md");
    expect(registry.list().queue.batchOpenedAt).toBe(
      new Date(START).toISOString(),
    );
  });

  it("queues a second document within the batch with the right releaseAt", () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    clock += 30 * MINUTE;

    const response = registry.open({
      tabs: [{ path: "/docs/b.md", label: "plan" }],
    });

    const releaseAt = new Date(START + 120 * MINUTE).toISOString();
    expect(response.results).toEqual([
      { path: "/docs/b.md", status: "queued", releaseAt },
    ]);
    expect(response.url).toBeUndefined();
    expect(registry.queueState()).toEqual({ count: 1, releaseAt });
    const timer = timers.filter((entry) => entry.live).at(-1);
    expect(timer?.delayMs).toBe(90 * MINUTE);
  });

  it("opens a request's files together or queues them together", () => {
    const registry = make();

    const first = registry.open({
      tabs: [{ path: "/docs/a.md" }, { path: "/docs/b.md" }],
    });
    expect(first.results.map((entry) => entry.status)).toEqual([
      "open-window",
      "open-window",
    ]);

    const second = registry.open({
      tabs: [{ path: "/docs/c.md" }, { path: "/docs/d.md" }],
    });
    expect(second.results.map((entry) => entry.status)).toEqual([
      "queued",
      "queued",
    ]);
    expect(registry.queueState().count).toBe(2);
  });

  it("adds a document at once with --now and leaves the batch clock alone", () => {
    const registry = make();
    const first = registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.poll(first.windowId as string, [tabState("/docs/a.md")]);
    clock += 10 * MINUTE;
    registry.poll(first.windowId as string, [tabState("/docs/a.md")]);

    const response = registry.open({
      tabs: [{ path: "/docs/b.md" }],
      now: true,
    });

    expect(response.results).toEqual([
      { path: "/docs/b.md", status: "added", windowId: first.windowId },
    ]);
    expect(registry.list().queue.batchOpenedAt).toBe(
      new Date(START).toISOString(),
    );
    const polled = registry.poll(first.windowId as string, [
      tabState("/docs/a.md"),
    ]);
    expect(polled.commands).toEqual([
      {
        type: "add",
        tabs: [{ path: "/docs/b.md", label: null, since: null }],
      },
    ]);
  });

  it("takes a queued document out of the queue when it is opened with --now", () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.open({ tabs: [{ path: "/docs/b.md" }] });
    expect(registry.queueState().count).toBe(1);

    const response = registry.open({
      tabs: [{ path: "/docs/b.md" }],
      now: true,
    });

    expect(response.results[0]?.status).toBe("added");
    expect(registry.queueState().count).toBe(0);
  });

  it("focuses a document a live window already shows", () => {
    const registry = make();
    const first = registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.poll(first.windowId as string, [tabState("/docs/a.md")]);

    const response = registry.open({ tabs: [{ path: "/docs/a.md" }] });

    expect(response.results).toEqual([
      { path: "/docs/a.md", status: "focused", windowId: first.windowId },
    ]);
    expect(
      registry.poll(first.windowId as string, [tabState("/docs/a.md")])
        .commands,
    ).toEqual([{ type: "focus", path: "/docs/a.md" }]);
  });

  it("keeps a still-queued document queued when it is opened again", () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.open({ tabs: [{ path: "/docs/b.md" }] });

    const again = registry.open({ tabs: [{ path: "/docs/b.md" }] });

    expect(again.results[0]?.status).toBe("queued");
    expect(registry.queueState().count).toBe(1);
  });

  it("opens at once and starts a new batch after the batch length has passed", () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    clock += 121 * MINUTE;

    const response = registry.open({ tabs: [{ path: "/docs/b.md" }] });

    expect(response.results[0]?.status).toBe("open-window");
    expect(registry.list().queue.batchOpenedAt).toBe(
      new Date(clock).toISOString(),
    );
  });

  it("releases the queue to a live window as an add command", async () => {
    const registry = make();
    const first = registry.open({ tabs: [{ path: "/docs/a.md" }] });
    const windowId = first.windowId as string;
    registry.poll(windowId, [tabState("/docs/a.md")]);
    registry.open({
      tabs: [{ path: "/docs/b.md", label: "plan", since: "HEAD~1" }],
    });
    clock += 5 * MINUTE;
    registry.poll(windowId, [tabState("/docs/a.md")]);

    const released = await registry.release();

    expect(released).toEqual({ released: 1, windowId });
    expect(opened).toEqual([]);
    expect(registry.queueState()).toEqual({
      count: 0,
      releaseAt: new Date(clock + 120 * MINUTE).toISOString(),
    });
    expect(registry.poll(windowId, [tabState("/docs/a.md")]).commands).toEqual([
      {
        type: "add",
        tabs: [{ path: "/docs/b.md", label: "plan", since: "HEAD~1" }],
      },
    ]);
  });

  it("opens a window with the saved Orca target when released with no window", async () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.open({
      tabs: [{ path: "/docs/b.md" }],
      orcaTarget: { command: "orca", worktree: "id:repo::/work" },
    });
    // The first window never polled and is long gone.
    clock += 120 * MINUTE;

    const released = await registry.release({ open: true });

    expect(released.released).toBe(1);
    expect(released.opened).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.orcaTarget).toEqual({
      command: "orca",
      worktree: "id:repo::/work",
    });
    expect(opened[0]?.url).toBe(released.url);
    expect(opened[0]?.url).toContain("tab=%2Fdocs%2Fb.md");
  });

  it("returns the window URL instead of opening it when the caller opens", async () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.open({ tabs: [{ path: "/docs/b.md" }] });
    clock += 120 * MINUTE;

    const released = await registry.release();

    expect(released.url).toContain("tab=%2Fdocs%2Fb.md");
    expect(opened).toEqual([]);
  });

  it("keeps the documents queued when the window could not be opened", async () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.open({ tabs: [{ path: "/docs/b.md" }] });
    clock += 120 * MINUTE;
    openResult = false;

    const released = await registry.release({ open: true });

    expect(released).toEqual({ released: 0, opened: false });
    expect(registry.queueState().count).toBe(1);
    expect(registry.list().windows.filter((entry) => entry.live)).toEqual([]);
  });

  it("releases from the timer, and the timer fires at the release time", async () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.open({ tabs: [{ path: "/docs/b.md" }] });
    const timer = timers.filter((entry) => entry.live).at(-1);
    expect(timer?.delayMs).toBe(120 * MINUTE);

    clock += 120 * MINUTE;
    timer?.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(opened).toHaveLength(1);
    expect(registry.queueState().count).toBe(0);
  });

  it("persists the queue and re-arms the timer after a restart", () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.open({
      tabs: [{ path: "/docs/b.md", label: "plan" }],
      orcaTarget: { command: "orca", worktree: null },
    });
    registry.dispose();
    const file = path.join(stateDir, "tab-queue.json");
    expect(fs.existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      batchOpenedAt: new Date(START).toISOString(),
      queued: [{ path: "/docs/b.md", label: "plan" }],
    });

    clock += 30 * MINUTE;
    timers = [];
    const restarted = make();
    restarted.restore();

    expect(restarted.queueState()).toEqual({
      count: 1,
      releaseAt: new Date(START + 120 * MINUTE).toISOString(),
    });
    expect(timers.filter((entry) => entry.live).at(-1)?.delayMs).toBe(
      90 * MINUTE,
    );
    expect(restarted.list().queue.items[0]?.orcaTarget).toEqual({
      command: "orca",
      worktree: null,
    });
  });

  it("honors ROUGHDRAFT_TAB_BATCH_MINUTES", () => {
    const registry = make({ env: { ROUGHDRAFT_TAB_BATCH_MINUTES: "10" } });
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    clock += 5 * MINUTE;
    expect(registry.open({ tabs: [{ path: "/docs/b.md" }] })).toMatchObject({
      results: [
        {
          status: "queued",
          releaseAt: new Date(START + 10 * MINUTE).toISOString(),
        },
      ],
    });
    clock += 6 * MINUTE;
    expect(registry.open({ tabs: [{ path: "/docs/c.md" }] }).results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/docs/c.md", status: "open-window" }),
      ]),
    );
  });

  it("joins the queue to a request that opens after the batch is due", () => {
    const registry = make();
    registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.open({ tabs: [{ path: "/docs/b.md" }] });
    clock += 121 * MINUTE;

    const response = registry.open({ tabs: [{ path: "/docs/c.md" }] });

    expect(response.results.map((entry) => entry.path).sort()).toEqual([
      "/docs/b.md",
      "/docs/c.md",
    ]);
    expect(registry.queueState().count).toBe(0);
  });

  it("treats a window as live for ten seconds after its last poll", () => {
    const registry = make();
    const first = registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.poll(first.windowId as string, [tabState("/docs/a.md")]);

    clock += 9_000;
    expect(
      registry.open({ tabs: [{ path: "/docs/a.md" }] }).results[0]?.status,
    ).toBe("focused");

    clock += 11_000;
    expect(
      registry.open({ tabs: [{ path: "/docs/a.md" }], now: true }).results[0]
        ?.status,
    ).toBe("open-window");
  });

  it("does not open a second window while the first is still loading", () => {
    const registry = make();
    const first = registry.open({ tabs: [{ path: "/docs/a.md" }] });
    clock += 5_000;

    const second = registry.open({
      tabs: [{ path: "/docs/b.md" }],
      now: true,
    });

    expect(second.results[0]).toMatchObject({
      status: "added",
      windowId: first.windowId,
    });
  });

  it("forgets a tab that vanishes from a live window's poll", () => {
    const registry = make();
    const first = registry.open({
      tabs: [{ path: "/docs/a.md" }, { path: "/docs/b.md" }],
    });
    const windowId = first.windowId as string;
    registry.poll(windowId, [tabState("/docs/a.md"), tabState("/docs/b.md")]);

    registry.poll(windowId, [tabState("/docs/a.md")]);

    expect(registry.list().windows[0]?.tabs.map((tab) => tab.path)).toEqual([
      "/docs/a.md",
    ]);
  });

  it("keeps a tab it just added while the page has not reported it yet", () => {
    const registry = make();
    const first = registry.open({ tabs: [{ path: "/docs/a.md" }] });
    const windowId = first.windowId as string;
    registry.poll(windowId, [tabState("/docs/a.md")]);
    registry.open({ tabs: [{ path: "/docs/b.md" }], now: true });

    registry.poll(windowId, [tabState("/docs/a.md")]);
    expect(registry.list().windows[0]?.tabs).toHaveLength(2);

    registry.poll(windowId, [tabState("/docs/a.md"), tabState("/docs/b.md")]);
    clock += 60_000;
    registry.poll(windowId, [tabState("/docs/a.md")]);
    expect(registry.list().windows[0]?.tabs).toHaveLength(1);
  });

  it("registers a window it has never heard of from its poll", () => {
    const registry = make();

    registry.poll("reloaded", [tabState("/docs/a.md", { openThreads: 2 })]);

    expect(registry.list().windows).toMatchObject([
      { id: "reloaded", live: true, tabs: [{ path: "/docs/a.md", openThreads: 2 }] },
    ]);
  });

  it("closes a tab through a command, or removes a queued document", () => {
    const registry = make();
    const first = registry.open({ tabs: [{ path: "/docs/a.md" }] });
    const windowId = first.windowId as string;
    registry.poll(windowId, [tabState("/docs/a.md")]);
    registry.open({ tabs: [{ path: "/docs/b.md" }] });

    expect(registry.close("/docs/a.md")).toEqual({
      closed: true,
      from: "window",
      windowId,
    });
    expect(registry.poll(windowId, [tabState("/docs/a.md")]).commands).toEqual([
      { type: "close", path: "/docs/a.md" },
    ]);
    expect(registry.close("/docs/b.md")).toEqual({
      closed: true,
      from: "queue",
    });
    expect(registry.queueState().count).toBe(0);
    expect(registry.close("/docs/zzz.md")).toEqual({ closed: false });
  });

  it("focuses a tab by path and refuses one no window shows", () => {
    const registry = make();
    const first = registry.open({ tabs: [{ path: "/docs/a.md" }] });
    registry.poll(first.windowId as string, [tabState("/docs/a.md")]);

    expect(registry.focus("/docs/a.md")).toEqual({
      focused: true,
      windowId: first.windowId,
    });
    expect(registry.focus("/docs/zzz.md")).toEqual({ focused: false });
  });

  it("defers to a plain single-document page that shows the file", () => {
    const registry = make({ isShownByPlainPage: (p) => p === "/docs/a.md" });

    const response = registry.open({ tabs: [{ path: "/docs/a.md" }] });

    expect(response.results).toEqual([
      { path: "/docs/a.md", status: "single-page" },
    ]);
    expect(response.url).toBeUndefined();
    expect(registry.list().queue.batchOpenedAt).toBeNull();
  });

  it("ignores a page that a tab window held a moment ago", () => {
    const registry = make({ isShownByPlainPage: () => true });
    registry.poll("w", [tabState("/docs/a.md")]);
    registry.poll("w", []);

    const response = registry.open({ tabs: [{ path: "/docs/a.md" }] });

    expect(response.results[0]?.status).toBe("added");
  });

  it("puts a tab's since in the window URL the way the page reads it", () => {
    expect(
      buildTabWindowUrl("w1", [{ path: "/docs/a.md", since: "HEAD~1" }]),
    ).toBe(
      "/tabs?window=w1&tab=%2Fdocs%2Fa.md&active=%2Fdocs%2Fa.md&since=HEAD%7E1%0A%2Fdocs%2Fa.md",
    );
  });
});
