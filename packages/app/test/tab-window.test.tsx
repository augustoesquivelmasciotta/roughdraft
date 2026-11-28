import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import {
  buildTabFrameUrl,
  buildTabWindowLocation,
  readTabWindowLocation,
  TAB_DONE_LINGER_MS,
  TabWindow,
} from "../src/TabWindow";
import type {
  TabWindowCommand,
  TabWindowQueueState,
} from "../src/tab-window-client";

const A = "/docs/a.md";
const B = "/docs/b.md";
const C = "/docs/c.md";

function queryByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

function getByTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  const element = queryByTestId<T>(container, testId);
  expect(element).not.toBeNull();
  return element as T;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function postFromFrame(data: unknown) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data, origin: window.location.origin }),
    );
    await Promise.resolve();
  });
}

describe("tab window", () => {
  let container: HTMLDivElement;
  let root: Root;
  let nextCommands: TabWindowCommand[];
  let queue: TabWindowQueueState;
  let polls: { windowId: string; tabs: Record<string, unknown>[] }[];
  let closeWindow: ReturnType<typeof vi.spyOn>;
  let closeTabRequests: string[];
  let closeTabResult: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    nextCommands = [];
    queue = { count: 0, releaseAt: null };
    polls = [];
    closeTabRequests = [];
    closeTabResult = true;
    closeWindow = vi.spyOn(window, "close").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url === "/api/tab-windows/poll") {
          polls.push(body);
          const commands = nextCommands;
          nextCommands = [];
          return new Response(JSON.stringify({ commands, queue }));
        }
        if (url === "/api/orca/close-tab") {
          closeTabRequests.push(body.url);
          return new Response(JSON.stringify({ closed: closeTabResult }));
        }
        return new Response("{}", { status: 404 });
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  async function renderTabWindow(search: string) {
    window.history.replaceState(null, "", `/tabs${search}`);
    await act(async () => {
      root.render(<TabWindow />);
      await Promise.resolve();
    });
    await advance(0);
  }

  const frame = (path: string) =>
    queryByTestId<HTMLIFrameElement>(container, `tab-window-frame-${path}`);
  const tabButton = (path: string) =>
    getByTestId(container, `tab-window-tab-${path}`);

  it("shows one tab per document with its file name and a counter", async () => {
    await renderTabWindow(
      `?window=w1&tab=${encodeURIComponent(A)}&tab=${encodeURIComponent(B)}`,
    );

    expect(tabButton(A).textContent).toContain("a.md");
    expect(tabButton(B).textContent).toContain("b.md");
    // The user asked for no counts in the strip (2026-11-28).
    expect(queryByTestId(container, "tab-window-progress")).toBeNull();
    expect(queryByTestId(container, "tab-window-waiting")).toBeNull();
  });

  it("carries a tab's since into its iframe, the add command and the window URL", async () => {
    await renderTabWindow(
      `?window=w1&tab=${encodeURIComponent(A)}&since=${encodeURIComponent(`HEAD~1\n${A}`)}`,
    );
    expect(frame(A)?.getAttribute("src")).toBe(
      "/?path=%2Fdocs%2Fa.md&since=HEAD%7E1&embedded=1",
    );

    nextCommands = [
      {
        type: "add",
        tabs: [{ path: C, label: "Claude", since: "/tmp/old.md" }],
      },
    ];
    await advance(1500);
    await click(tabButton(C));
    expect(frame(C)?.getAttribute("src")).toBe(
      "/?path=%2Fdocs%2Fc.md&label=Claude&since=%2Ftmp%2Fold.md&embedded=1",
    );

    const sinceParams = new URLSearchParams(window.location.search).getAll(
      "since",
    );
    expect(sinceParams).toEqual([`HEAD~1\n${A}`, `/tmp/old.md\n${C}`]);
  });

  it("creates an iframe the first time a tab is activated and keeps it mounted while hidden", async () => {
    await renderTabWindow(
      `?window=w1&tab=${encodeURIComponent(A)}&tab=${encodeURIComponent(B)}`,
    );

    expect(frame(A)).not.toBeNull();
    expect(frame(B)).toBeNull();
    expect(frame(A)?.getAttribute("src")).toBe(
      "/?path=%2Fdocs%2Fa.md&embedded=1",
    );

    await click(tabButton(B));
    const firstA = frame(A);
    expect(frame(B)).not.toBeNull();
    expect(firstA?.classList.contains("hidden")).toBe(true);
    expect(frame(B)?.classList.contains("hidden")).toBe(false);

    await click(tabButton(A));
    expect(frame(A)).toBe(firstA);
    expect(frame(B)?.classList.contains("hidden")).toBe(true);
  });

  it("marks a tab with open threads with a dot, and clears it at zero", async () => {
    await renderTabWindow(`?window=w1&tab=${encodeURIComponent(A)}`);
    expect(queryByTestId(container, `tab-window-open-${A}`)).toBeNull();

    await postFromFrame({
      type: "roughdraft:tab-state",
      path: A,
      openThreads: 2,
    });
    expect(queryByTestId(container, `tab-window-open-${A}`)).not.toBeNull();

    await postFromFrame({
      type: "roughdraft:tab-state",
      path: A,
      openThreads: 0,
    });
    expect(queryByTestId(container, `tab-window-open-${A}`)).toBeNull();
  });

  it("ignores messages from another origin", async () => {
    await renderTabWindow(`?window=w1&tab=${encodeURIComponent(A)}`);

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "roughdraft:tab-state", path: A, openThreads: 3 },
          origin: "https://example.com",
        }),
      );
      await Promise.resolve();
    });

    expect(queryByTestId(container, `tab-window-open-${A}`)).toBeNull();
  });

  it("says nothing about queued documents while the queue has items", async () => {
    queue = { count: 3, releaseAt: "2026-11-28T18:00:00.000Z" };
    await renderTabWindow(`?window=w1&tab=${encodeURIComponent(A)}`);
    await advance(1500);

    expect(queryByTestId(container, "tab-window-waiting")).toBeNull();
    expect(container.textContent).not.toMatch(/waiting|queued/i);
  });

  it("closes a tab with its x button and keeps the others", async () => {
    await renderTabWindow(
      `?window=w1&tab=${encodeURIComponent(A)}&tab=${encodeURIComponent(B)}`,
    );

    await click(getByTestId(container, `tab-window-close-${A}`));

    expect(queryByTestId(container, `tab-window-tab-${A}`)).toBeNull();
    expect(frame(A)).toBeNull();
    expect(tabButton(B).getAttribute("data-active")).toBe("true");
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("closes the window itself when its last tab goes away", async () => {
    await renderTabWindow(`?window=w1&tab=${encodeURIComponent(A)}`);

    await click(getByTestId(container, `tab-window-close-${A}`));
    await advance(200);

    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(closeTabRequests).toEqual([window.location.href]);
    expect(queryByTestId(container, "tab-window-empty")?.textContent).toBe(
      "Waiting for documents to review.",
    );
  });

  it("says how to close the window when closing it failed", async () => {
    closeTabResult = false;
    await renderTabWindow(`?window=w1&tab=${encodeURIComponent(A)}`);

    await click(getByTestId(container, `tab-window-close-${A}`));
    await advance(200);

    expect(getByTestId(container, "tab-window-empty").textContent).toContain(
      "Close this tab from the tab bar.",
    );
  });

  it("does not close an empty window that never had tabs", async () => {
    await renderTabWindow("?window=w1");
    await advance(500);

    expect(closeWindow).not.toHaveBeenCalled();
    expect(closeTabRequests).toEqual([]);
  });

  it("marks a delivered tab done, brings the next unfinished tab forward and removes it", async () => {
    await renderTabWindow(
      `?window=w1&tab=${encodeURIComponent(A)}&tab=${encodeURIComponent(B)}&tab=${encodeURIComponent(C)}`,
    );

    await postFromFrame({ type: "roughdraft:review-delivered", path: A });

    expect(queryByTestId(container, `tab-window-done-${A}`)).not.toBeNull();
    expect(tabButton(B).getAttribute("data-active")).toBe("true");
    expect(frame(B)).not.toBeNull();

    await advance(TAB_DONE_LINGER_MS + 10);

    expect(queryByTestId(container, `tab-window-tab-${A}`)).toBeNull();
    expect(frame(A)).toBeNull();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("closes the window after the last unfinished tab is delivered", async () => {
    await renderTabWindow(
      `?window=w1&tab=${encodeURIComponent(A)}&tab=${encodeURIComponent(B)}`,
    );

    await postFromFrame({ type: "roughdraft:review-delivered", path: A });
    await postFromFrame({ type: "roughdraft:review-delivered", path: B });
    await advance(TAB_DONE_LINGER_MS + 300);

    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it("polls every 1.5 seconds with the state of its tabs", async () => {
    await renderTabWindow(
      `?window=w1&tab=${encodeURIComponent(A)}&tab=${encodeURIComponent(B)}`,
    );
    await postFromFrame({
      type: "roughdraft:tab-state",
      path: B,
      openThreads: 2,
    });
    expect(polls).toHaveLength(1);

    await advance(1500);

    expect(polls).toHaveLength(2);
    expect(polls[1]).toEqual({
      windowId: "w1",
      tabs: [
        { path: A, label: null, active: true, done: false, openThreads: 0 },
        { path: B, label: null, active: false, done: false, openThreads: 2 },
      ],
    });
  });

  it("applies add, focus and close commands from the server", async () => {
    await renderTabWindow(
      `?window=w1&tab=${encodeURIComponent(A)}&tab=${encodeURIComponent(B)}`,
    );

    nextCommands = [
      { type: "add", tabs: [{ path: C, label: "Claude" }] },
      { type: "focus", path: B },
    ];
    await advance(1500);

    expect(tabButton(C).textContent).toContain("c.md");
    expect(tabButton(B).getAttribute("data-active")).toBe("true");
    expect(frame(B)).not.toBeNull();

    await click(tabButton(C));
    expect(frame(C)?.getAttribute("src")).toBe(
      "/?path=%2Fdocs%2Fc.md&label=Claude&embedded=1",
    );

    nextCommands = [{ type: "close", path: A }];
    await advance(1500);

    expect(queryByTestId(container, `tab-window-tab-${A}`)).toBeNull();
  });

  it("keeps the URL in step with the tabs and the active tab", async () => {
    await renderTabWindow(
      `?window=w1&tab=${encodeURIComponent(A)}&tab=${encodeURIComponent(B)}`,
    );
    expect(window.location.search).toBe(
      `?window=w1&tab=${encodeURIComponent(A)}&tab=${encodeURIComponent(B)}&active=${encodeURIComponent(A)}`,
    );

    await click(tabButton(B));
    expect(new URLSearchParams(window.location.search).get("active")).toBe(B);

    await click(getByTestId(container, `tab-window-close-${A}`));
    const params = new URLSearchParams(window.location.search);
    expect(params.getAll("tab")).toEqual([B]);
    expect(params.get("window")).toBe("w1");
    expect(window.location.pathname).toBe("/tabs");
  });

  it("is what the app renders on the /tabs route", async () => {
    window.history.replaceState(null, "", `/tabs?window=w1&tab=${A}`);
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });

    expect(queryByTestId(container, "tab-window")).not.toBeNull();
  });
});

describe("tab window URLs", () => {
  it("reads the window, tabs and active tab, falling back to the first tab", () => {
    const parsed = readTabWindowLocation(
      "?window=w1&tab=%2Fa.md&tab=%2Fb.md&tab=%2Fa.md&active=%2Fnope.md",
    );

    expect(parsed).toEqual({
      windowId: "w1",
      paths: ["/a.md", "/b.md"],
      active: "/a.md",
    });
  });

  it("builds the same URL back", () => {
    const location = buildTabWindowLocation({
      windowId: "w1",
      paths: ["/a.md", "/b.md"],
      active: "/b.md",
    });

    expect(location).toBe(
      "/tabs?window=w1&tab=%2Fa.md&tab=%2Fb.md&active=%2Fb.md",
    );
    expect(
      buildTabWindowLocation({
        windowId: "w1",
        paths: ["/a.md"],
        active: "/a.md",
        sinceByPath: { "/a.md": "main" },
      }),
    ).toBe("/tabs?window=w1&tab=%2Fa.md&active=%2Fa.md&since=main%0A%2Fa.md");
    expect(buildTabFrameUrl("/a.md", null, "main")).toBe(
      "/?path=%2Fa.md&since=main&embedded=1",
    );
    expect(buildTabFrameUrl("/a.md", null)).toBe("/?path=%2Fa.md&embedded=1");
  });
});
