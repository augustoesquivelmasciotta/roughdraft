import { expect, test, type Page } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  selectRichText,
  writeProjectFile,
} from "./helpers";

test.describe("CriticMarkup review flows", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("criticmarkup");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("Escape closes the review sheet and the file menu, innermost first", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    const filePath = writeProjectFile(
      projectDir,
      "escape.md",
      [
        "# Escape",
        "",
        'This paragraph has {==target text==}{>>Needs detail<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await page.locator(".comment-anchor[data-comment-ids]").first().click();
    const sheet = page.getByTestId("document-review-sheet");
    await expect(sheet).toBeVisible();

    // Open the menu from the keyboard: a mouse click outside the thread
    // would already deselect it.
    await page.getByTestId("document-file-menu-trigger").focus();
    await page.keyboard.press("Enter");
    const fileMenu = page.getByTestId("document-file-menu");
    await expect(fileMenu).toBeVisible();

    // First Escape closes the menu on top, the sheet stays.
    await page.keyboard.press("Escape");
    await expect(fileMenu).toBeHidden();
    await expect(sheet).toBeVisible();

    // Second Escape closes the sheet.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // Nothing open: Escape is harmless.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("rich-text-editor")).toBeVisible();
  });

  test("renders a comment thread and saves a reply @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "comment.md",
      [
        "# Comment Review",
        "",
        'This paragraph has {==target text==}{>>Needs detail<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Needs detail",
    );

    await page
      .getByTestId("comment-rail-c1-action-reply")
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
      });
    await page
      .getByTestId("comment-rail-c2-editor")
      .fill("Added context looks good.");
    await page
      .getByTestId("comment-rail-c2-action-save")
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
      });

    await expect
      .poll(() => readProjectFile(projectDir, "comment.md"))
      .toContain("Added context looks good.");
    expect(readProjectFile(projectDir, "comment.md")).toContain('re="c1"');

    logE2eEvent("criticmarkup.reply-saved", {
      file: "comment.md",
    });
  });

  test("creates a new root comment and saves it to disk @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "new-comment.md",
      [
        "# New Comment",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await page.getByTestId("selection-menu-action-comment").click();
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("Clarify this phrase.");
    await page.getByTestId("comment-rail-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, "new-comment.md"))
      .toMatch(
        /\{==target text==\}\{>>Clarify this phrase\.<<\}\{id="c1" by="user" at="[^"]+"\}/,
      );

    logE2eEvent("criticmarkup.root-comment-saved", {
      file: "new-comment.md",
    });
  });

  test("keeps typed CriticMarkup literal in a comment body @smoke", async ({
    page,
  }) => {
    const typedBody = "Write {>>a note<<} or {++an insert++} here.";
    const filePath = writeProjectFile(
      projectDir,
      "typed-markup-comment.md",
      [
        "# Typed Markup Comment",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await page.getByTestId("selection-menu-action-comment").click();
    await page.getByTestId("comment-rail-c1-editor").fill(typedBody);
    await page.getByTestId("comment-rail-c1-action-save").click();

    await expect
      .poll(() => readProjectFile(projectDir, "typed-markup-comment.md"))
      .toContain("{==target text==}");

    const savedMarkdown = readProjectFile(
      projectDir,
      "typed-markup-comment.md",
    );
    expect(savedMarkdown).toContain(
      "{>>Write \\{>>a note\\<<} or \\{++an insert\\++} here.<<}",
    );

    await page.reload();
    await expect(page.getByTestId("comment-rail-c1")).toContainText(typedBody);
    await expect(page.getByTestId("comment-thread-c1")).toHaveCount(1);
    await expect(page.getByTestId("comment-rail-c2")).toHaveCount(0);

    logE2eEvent("criticmarkup.typed-markup-comment-escaped", {
      file: "typed-markup-comment.md",
    });
  });

  test("keeps typed CriticMarkup literal inside an edited mark @smoke", async ({
    page,
  }) => {
    const typedText = "{++live++}";
    const filePath = writeProjectFile(
      projectDir,
      "typed-markup-mark.md",
      [
        "# Typed Markup Mark",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await page
      .getByTestId("rich-text-editor")
      .dispatchEvent("contextmenu", { clientX: 200, clientY: 200 });
    await page
      .getByTestId("editor-context-menu-action-suggest-replacement")
      .click();
    await page.getByTestId("draft-suggestion-editor").fill(typedText);
    await page.getByTestId("draft-suggestion-action-apply").click();

    await expect
      .poll(() => readProjectFile(projectDir, "typed-markup-mark.md"))
      .toContain("{~~target text~>");

    const savedMarkdown = readProjectFile(projectDir, "typed-markup-mark.md");
    expect(savedMarkdown).toContain("{~~target text~>\\{++live\\++}~~}");

    await page.reload();
    await expect(page.getByTestId("suggestion-thread-s1")).toContainText(
      typedText,
    );
    await expect(page.getByTestId("suggestion-thread-s2")).toHaveCount(0);

    logE2eEvent("criticmarkup.typed-markup-mark-escaped", {
      file: "typed-markup-mark.md",
    });
  });

  test("animates the document layout when the review rail appears and disappears @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "layout-animation.md",
      [
        "# Layout Animation",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await page.getByTestId("selection-menu-action-comment").waitFor();

    const addSamplesPromise = sampleReviewLayoutAnimation(page);
    await page.getByTestId("selection-menu-action-comment").click();
    const addSamples = await addSamplesPromise;

    expect(hasAnimatedReviewLayout(addSamples)).toBe(true);
    await page
      .getByTestId("comment-rail-c1-editor")
      .fill("Clarify this phrase.");
    await page.getByTestId("comment-rail-c1-action-save").click();

    await page.getByTestId("comment-rail-c1-action-delete-thread").waitFor();
    const removeSamplesPromise = sampleReviewLayoutAnimation(page);
    await page.getByTestId("comment-rail-c1-action-delete-thread").click();
    const removeSamples = await removeSamplesPromise;

    expect(hasAnimatedReviewLayout(removeSamples)).toBe(true);

    logE2eEvent("criticmarkup.layout-animation", {
      file: "layout-animation.md",
    });
  });

  test("shows tooltips for selection menu formatting actions", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "selection-tooltips.md",
      [
        "# Selection Tooltips",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");

    await page.getByTestId("selection-menu-action-bold").hover();
    await expect(page.getByTestId("selection-menu-action-tooltip")).toHaveText(
      "Bold",
    );

    await expect(
      page.getByTestId("selection-menu-action-suggest-insertion"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("selection-menu-action-suggest-deletion"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("selection-menu-action-suggest-replacement"),
    ).toHaveCount(0);

    await page.getByTestId("selection-menu-action-comment").hover();
    await expect(page.getByTestId("selection-menu-action-tooltip")).toHaveCount(
      0,
    );
  });

  test("shows endmatter replies, resolves and deletes from always-visible actions @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "resolve.md",
      [
        "# Resolve And Delete",
        "",
        'First {==claim==}{>>Needs a source<<}{id="c1" by="user" at="2026-10-01T10:00:00.000Z"} here.',
        "",
        'Second {==point==}{>>Too vague<<}{id="c2" by="user" at="2026-10-01T10:05:00.000Z"} there.',
        "",
        "---",
        "comments:",
        "  c3:",
        "    body: Added the 2025 report.",
        "    by: AI",
        '    at: "2026-10-01T11:00:00.000Z"',
        "    re: c1",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    // The endmatter reply is threaded under its inline-attribute root.
    await expect(page.getByTestId("comment-thread-c1")).toContainText(
      "Added the 2025 report.",
    );

    // No need to select the thread first: its actions work directly.
    await page.getByTestId("comment-rail-c1-action-resolve").click();
    await expect
      .poll(() => readProjectFile(projectDir, "resolve.md"))
      .toContain(
        '{>>Needs a source<<}{id="c1" by="user" at="2026-10-01T10:00:00.000Z" status="resolved"}',
      );
    await expect(
      page.getByTestId("comment-rail-c1-resolved-badge"),
    ).toBeVisible();

    await page.getByTestId("comment-rail-c2-action-delete").click();
    await expect
      .poll(() => readProjectFile(projectDir, "resolve.md"))
      .toMatch(/deleted:\n {2}- id: c2\n/);
    const saved = readProjectFile(projectDir, "resolve.md");
    expect(saved).toContain("Second point there.");
    expect(saved).toContain("    body: Too vague");
    expect(saved).toContain("    anchor: point");
    expect(saved).toContain("    body: Added the 2025 report.");
  });

  test("jumps between open comments without scrolling through resolved ones", async ({
    page,
  }) => {
    const filler = Array.from(
      { length: 40 },
      (_, index) => `Filler paragraph ${index + 1}.`,
    );
    const filePath = writeProjectFile(
      projectDir,
      "navigate.md",
      [
        "# Navigate",
        "",
        'Resolved {==old==}{>>Done already<<}{id="c1" by="user" at="2026-10-01T10:00:00.000Z" status="resolved"}.',
        "",
        ...filler.slice(0, 20).flatMap((line) => [line, ""]),
        'Open {==middle==}{>>Still open<<}{id="c2" by="user" at="2026-10-01T10:05:00.000Z"}.',
        "",
        ...filler.slice(20).flatMap((line) => [line, ""]),
        'Open {==bottom==}{>>Also open<<}{id="c3" by="user" at="2026-10-01T10:06:00.000Z"}.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-navigator-filter-open")).toHaveText(
      "2 open",
    );

    await page.getByTestId("review-navigator-next").click();
    await expect(page.getByTestId("comment-thread-c2")).toBeInViewport();
    await page.getByTestId("review-navigator-next").click();
    await expect(page.getByTestId("comment-thread-c3")).toBeInViewport();
    await page.getByTestId("review-navigator-next").click();
    await expect(page.getByTestId("comment-thread-c2")).toBeInViewport();
  });

  test("removes a disposable anchor with its replied thread and keeps an unflagged anchor @smoke", async ({
    page,
  }) => {
    const relativePath = "disposable-anchor.md";
    // The flagged thread carries a reply because that is the loop's normal
    // shape: the agent answers every thread inline before the reviewer clears
    // it, and clearing the root and its replies together is what left the
    // filler sentence behind until the removal read the whole set at once.
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      [
        "# Disposable Anchors",
        "",
        '{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2026-04-23T18:00:00.000Z" anchor="disposable"}{>>Free tier first.<<}{id="r1" by="user" at="2026-04-23T18:05:00.000Z" re="c1"}',
        "",
        'Keep {==this sentence==}{>>Needs a source<<}{id="c2" by="AI" at="2026-04-23T18:01:00.000Z"} as prose.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    const rail = page.getByTestId("document-review-rail");
    await expect(rail).toContainText("Free tier first.");

    // A deleted thread keeps a record in the endmatter `deleted` list, anchor
    // text included, so these checks read the document body only.
    const readBody = () =>
      readProjectFile(projectDir, relativePath).split("\n---\n")[0] ?? "";

    await page.getByTestId("comment-thread-c1").click();
    await page.getByTestId("comment-rail-c1-action-delete-thread").click();

    await expect
      .poll(readBody)
      .not.toContain("Placeholder for the pricing decision.");
    await expect(page.getByTestId("rich-text-editor")).not.toContainText(
      "Placeholder for the pricing decision.",
    );
    const afterFlaggedThread = readBody();
    expect(afterFlaggedThread).not.toContain('id="r1"');
    expect(afterFlaggedThread).not.toContain("Free tier first.");
    expect(afterFlaggedThread).toContain(
      '{==this sentence==}{>>Needs a source<<}{id="c2"',
    );

    await page.getByTestId("comment-thread-c2").click();
    await page.getByTestId("comment-rail-c2-action-delete-thread").click();

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .not.toContain('id="c2"');
    const savedMarkdown = readProjectFile(projectDir, relativePath);
    expect(readBody()).toContain("Keep this sentence as prose.");
    expect(readBody()).not.toContain("Placeholder");
    // The cleared threads stay on record, filler anchor text included.
    expect(savedMarkdown).toContain("deleted:");
    expect(savedMarkdown).toContain(
      "anchor: Placeholder for the pricing decision.",
    );

    logE2eEvent("criticmarkup.disposable-anchor-cleared", {
      file: relativePath,
    });
  });

  test("collapses a thread to its anchor plus the newest reply until expanded @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "collapsed-thread.md",
      [
        "# Collapsed Thread",
        "",
        'This paragraph has {==target text==}{>>Needs detail<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}{>>First follow-up<<}{id="c2" by="user" at="2026-04-23T18:01:00.000Z" re="c1"}{>>Newest follow-up<<}{id="c3" by="user" at="2026-04-23T18:02:00.000Z" re="c1"}.',
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    const rail = page.getByTestId("document-review-rail");
    await expect(rail.getByTestId("comment-rail-c1")).toBeVisible();
    await expect(rail.getByTestId("comment-rail-c3")).toBeVisible();
    await expect(rail.getByTestId("comment-rail-c2")).toHaveCount(0);
    await expect(
      rail.getByTestId("comment-rail-c1-action-expand-replies"),
    ).toContainText("1 earlier reply");

    // Actions are clickable on every thread here, so no selection first: a
    // click on the thread's middle would land on the toggle itself.
    await rail.getByTestId("comment-rail-c1-action-expand-replies").click();

    await expect(rail.getByTestId("comment-rail-c2")).toBeVisible();
    const [rootBox, firstReplyBox, newestReplyBox] = await Promise.all([
      rail.getByTestId("comment-rail-c1").boundingBox(),
      rail.getByTestId("comment-rail-c2").boundingBox(),
      rail.getByTestId("comment-rail-c3").boundingBox(),
    ]);
    expect(rootBox?.y).toBeLessThan(firstReplyBox?.y ?? Number.NaN);
    expect(firstReplyBox?.y).toBeLessThan(newestReplyBox?.y ?? Number.NaN);

    await rail.getByTestId("comment-rail-c1-action-collapse-replies").click();

    await expect(rail.getByTestId("comment-rail-c2")).toHaveCount(0);
    await expect(rail.getByTestId("comment-rail-c3")).toBeVisible();
    await expect(
      rail.getByTestId("comment-rail-c1-action-expand-replies"),
    ).toBeVisible();

    logE2eEvent("criticmarkup.thread-collapse-toggled", {
      file: "collapsed-thread.md",
    });
  });

  test("applies approved, rejected and edited marks on disk at Done Reviewing @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "suggestions.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      [
        "# Suggestion Review",
        "",
        'Keep {++clear wording++}{id="s1" by="AI" at="2026-04-23T18:00:00.000Z"} here.',
        "",
        'Remove {~~drafty~>rough~~}{id="s2" by="AI" at="2026-04-23T18:01:00.000Z"}{>>Rough is closer.<<}{id="c1" by="user" at="2026-04-23T18:02:00.000Z" re="s2"} there.',
        "",
        'Then {~~old~>new~~}{id="s3" by="AI" at="2026-04-23T18:03:00.000Z"} ends.',
        "",
      ].join("\n"),
    );
    const pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await expect(page.locator('[data-critic-change-id="s1"]')).toBeVisible();
    const rail = page.getByTestId("document-review-rail");

    await rail.getByTestId("comment-rail-s1-action-approve").click();
    await expect(
      rail.getByTestId("comment-rail-s1-approve-confirm"),
    ).toContainText("Approve");
    await rail.getByTestId("comment-rail-s1-action-approve-confirm").click();
    await expect(
      rail.getByTestId("comment-rail-s1-approval-pending"),
    ).toHaveText("Approved");

    await rail.getByTestId("comment-rail-s2-action-reject").click();
    await expect(
      rail.getByTestId("comment-rail-s2-approval-pending"),
    ).toHaveText("Rejected");

    await rail.getByTestId("comment-rail-s3-action-edit").click();
    const editor = rail.getByTestId("comment-rail-s3-editor");
    await expect(editor).toHaveValue("new");
    await editor.fill("newer");
    await rail.getByTestId("comment-rail-s3-action-save").click();
    await expect(
      rail.getByTestId("comment-rail-s3-approval-pending"),
    ).toHaveText("Edited");
    await expect(rail.getByTestId("suggestion-thread-s3")).toContainText(
      '"newer"',
    );

    // Autosave debounces at 500ms; a pending decision must outlast that
    // without touching the file.
    await page.waitForTimeout(1200);
    expect(readProjectFile(projectDir, relativePath)).toContain("{++");
    expect(readProjectFile(projectDir, relativePath)).toContain("{~~");

    await expect(page.getByTestId("review-handoff-button")).toBeVisible();
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Your agent is now working",
    );

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toContain("Keep clear wording here.");
    const savedMarkdown = readProjectFile(projectDir, relativePath);
    expect(savedMarkdown).toContain("Remove drafty there.");
    expect(savedMarkdown).toContain("Then newer ends.");
    expect(savedMarkdown).not.toContain("{++");
    expect(savedMarkdown).not.toContain("{~~");
    expect(savedMarkdown).not.toContain("Rough is closer.");
    await expect(rail.getByTestId("suggestion-thread-s1")).toHaveCount(0);
    await expect(rail.getByTestId("suggestion-thread-s2")).toHaveCount(0);
    await expect(rail.getByTestId("suggestion-thread-s3")).toHaveCount(0);

    await pendingWatch;

    logE2eEvent("criticmarkup.mark-decisions-applied", {
      file: relativePath,
    });
  });
});

type ReviewLayoutAnimationSample = {
  shellAnimating: boolean;
  headerAnimating: boolean;
  shellTranslateX: number;
  headerTranslateX: number;
};

async function sampleReviewLayoutAnimation(page: Page) {
  return page.evaluate(async () => {
    const readTranslateX = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return 0;
      const transform = getComputedStyle(element).transform;
      if (transform === "none") return 0;
      return new DOMMatrixReadOnly(transform).m41;
    };
    const samples: ReviewLayoutAnimationSample[] = [];
    const start = performance.now();

    while (performance.now() - start < 500) {
      const shell = document.querySelector(
        '[data-testid="document-page-shell"]',
      );
      const header = document.querySelector(
        '[data-testid="document-page-header"]',
      );
      samples.push({
        shellAnimating:
          shell instanceof HTMLElement &&
          shell.classList.contains("review-layout-grid--animating"),
        headerAnimating:
          header instanceof HTMLElement &&
          header.classList.contains("review-layout-grid--animating"),
        shellTranslateX: readTranslateX(shell),
        headerTranslateX: readTranslateX(header),
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    return samples;
  });
}

function hasAnimatedReviewLayout(samples: ReviewLayoutAnimationSample[]) {
  return samples.some(
    (sample) =>
      sample.shellAnimating &&
      sample.headerAnimating &&
      Math.abs(sample.shellTranslateX) > 1 &&
      Math.abs(sample.headerTranslateX) > 1,
  );
}
