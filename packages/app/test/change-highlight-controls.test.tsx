import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiBackend } from "../src/api-backend";
import { ChangeHighlightControls } from "../src/ChangeHighlightControls";
import { criticMarkdownToEditorState } from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";
import type { DocumentBaseline, StorageBackend } from "../src/storage";
import { useChangeHighlight } from "../src/use-change-highlight";

const baselineMarkdown =
  "# Plan\n\nKeep this.\n\nGoing away.\n\nEdit me please now.\n";
const currentMarkdown =
  "# Plan\n\nKeep this.\n\nEdit me later today.\n\nBrand new.\n";

function byTestId<T extends Element = HTMLElement>(
  container: ParentNode,
  testId: string,
) {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function Harness({
  editor,
  backend,
  since,
}: {
  editor: Editor;
  backend: StorageBackend;
  since: string | null;
}) {
  const highlight = useChangeHighlight({
    editor,
    backend,
    path: "/docs/a.md",
    since,
  });
  return (
    <ChangeHighlightControls
      view={highlight.view}
      onToggle={highlight.toggleVisible}
      onNext={highlight.next}
      onPrevious={highlight.previous}
    />
  );
}

describe("Changes toolbar controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: Editor;
  let getDocumentBaseline: ReturnType<typeof vi.fn>;
  let baseline: DocumentBaseline | null;

  const backend = () => ({ getDocumentBaseline }) as unknown as StorageBackend;

  const renderControls = async (since: string | null = null) => {
    await act(async () => {
      root.render(
        <Harness editor={editor} backend={backend()} since={since} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    baseline = {
      source: "last-review",
      label: "the last review",
      content: baselineMarkdown,
    };
    getDocumentBaseline = vi.fn(async () => baseline);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const element = document.createElement("div");
    document.body.appendChild(element);
    editor = new Editor({
      element,
      extensions: createEditorExtensions(""),
      content: criticMarkdownToEditorState(currentMarkdown).doc,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    editor.destroy();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const blocks = () =>
    editor.view.dom.querySelectorAll('[data-testid="change-block"]');

  it("fetches the baseline for the since value and shows the count", async () => {
    await renderControls("HEAD~1");

    expect(getDocumentBaseline).toHaveBeenCalledWith("/docs/a.md", "HEAD~1");
    expect(byTestId(container, "change-highlight-count")?.textContent).toBe(
      "3 changes",
    );
    expect(blocks()).toHaveLength(2);
  });

  it("asks for the last review when there is no since", async () => {
    await renderControls(null);
    expect(getDocumentBaseline).toHaveBeenCalledWith("/docs/a.md", null);
  });

  it("hides and shows the colors with the Changes toggle", async () => {
    await renderControls();
    const toggle = byTestId(container, "change-highlight-toggle");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");

    await click(toggle);
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(blocks()).toHaveLength(0);
    // The count stays, so the reader can turn it back on.
    expect(byTestId(container, "change-highlight-count")?.textContent).toBe(
      "3 changes",
    );

    await click(toggle);
    expect(blocks()).toHaveLength(2);
  });

  it("jumps to the next and previous change", async () => {
    await renderControls();

    await click(byTestId(container, "change-highlight-next"));
    expect(byTestId(container, "change-highlight-count")?.textContent).toBe(
      "1 of 3 changes",
    );
    expect(
      editor.view.dom.querySelectorAll(
        '[data-testid="change-block"][data-change-current="true"]',
      ),
    ).toHaveLength(1);

    await click(byTestId(container, "change-highlight-next"));
    expect(byTestId(container, "change-highlight-count")?.textContent).toBe(
      "2 of 3 changes",
    );
    await click(byTestId(container, "change-highlight-previous"));
    expect(byTestId(container, "change-highlight-count")?.textContent).toBe(
      "1 of 3 changes",
    );
  });

  it("shows nothing extra without a baseline", async () => {
    baseline = null;
    await renderControls();

    expect(byTestId(container, "change-highlight-controls")).toBeNull();
    expect(blocks()).toHaveLength(0);
  });

  it("shows nothing extra when the baseline equals the document", async () => {
    baseline = {
      source: "last-review",
      label: "the last review",
      content: currentMarkdown,
    };
    await renderControls();

    expect(byTestId(container, "change-highlight-controls")).toBeNull();
    expect(blocks()).toHaveLength(0);
  });
});

describe("ApiBackend.getDocumentBaseline", () => {
  const originalFetch = global.fetch;
  let requested: string[];

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function backendReplying(respond: () => Response) {
    requested = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return respond();
    }) as typeof fetch;
    return new ApiBackend({
      name: "Local",
      detail: "",
      projectPath: "/docs",
    } as ConstructorParameters<typeof ApiBackend>[0]);
  }

  it("asks for the last review by default and for a ref or file when given", async () => {
    const payload = { source: "git", label: "HEAD~1", content: "old" };
    const api = backendReplying(() => new Response(JSON.stringify(payload)));

    expect(await api.getDocumentBaseline("a.md")).toEqual(payload);
    await api.getDocumentBaseline("a.md", "HEAD~1");

    const first = new URL(requested[0] ?? "", "http://x");
    const second = new URL(requested[1] ?? "", "http://x");
    expect(first.pathname).toBe("/api/document-baseline");
    expect(first.searchParams.get("since")).toBe("last-review");
    expect(first.searchParams.get("path")).toBe("a.md");
    expect(second.searchParams.get("since")).toBe("HEAD~1");
  });

  it("resolves null on 404", async () => {
    const api = backendReplying(() => new Response("{}", { status: 404 }));
    expect(await api.getDocumentBaseline("a.md")).toBeNull();
  });
});
