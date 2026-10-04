import { expect, type Page, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";
import { orcaMobile } from "./orca-mobile-input";

// Orca mobile's "mobile" view lays the computer's tab out at the phone's size.
test.use({
  viewport: { width: 390, height: 760 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: false,
});

/** A point just inside the first or last character of `text` in the editor. */
async function textEdge(page: Page, text: string, edge: "start" | "end") {
  return page.getByTestId("rich-text-editor").evaluate(
    (editor, { text, edge }) => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent?.indexOf(text) ?? -1;
        if (index < 0) continue;
        const offset = edge === "start" ? index : index + text.length - 1;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        return {
          x: edge === "start" ? rect.left + 1 : rect.right - 1,
          y: rect.top + rect.height / 2,
        };
      }
      throw new Error(`Text not found: ${text}`);
    },
    { text, edge },
  );
}

test.describe("Orca mobile", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("orca-mobile");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("a tap places the caret and a Shift tap selects up to the second tap @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "select.md",
      ["# Select", "", "Phones review this sentence too.", ""].join("\n"),
    );
    await openMarkdownFile(page, filePath);
    const phone = await orcaMobile(page);

    const start = await textEdge(page, "review", "start");
    const end = await textEdge(page, "sentence", "end");
    await phone.tap(start.x, start.y);
    await phone.tap(end.x, end.y, { modifiers: ["shift"] });

    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("review this sentence");
    await expect(page.getByTestId("selection-menu")).toBeVisible();
  });

  test("adds a comment from the phone @smoke", async ({ page }) => {
    const filePath = writeProjectFile(
      projectDir,
      "comment.md",
      ["# Comment", "", "The rollout needs a date.", ""].join("\n"),
    );
    await openMarkdownFile(page, filePath);
    const phone = await orcaMobile(page);

    const start = await textEdge(page, "rollout", "start");
    const end = await textEdge(page, "date", "end");
    await phone.tap(start.x, start.y);
    await phone.tap(end.x, end.y, { modifiers: ["shift"] });
    await phone.tapElement(page.getByTestId("selection-menu-action-comment"));

    const sheet = page.getByTestId("document-review-sheet");
    const editor = sheet.getByTestId("comment-rail-c1-editor");
    await expect(editor).toBeVisible();
    await phone.tapElement(editor);
    await phone.type("Which week?");
    await phone.tapElement(sheet.getByTestId("comment-rail-c1-action-save"));

    await expect
      .poll(() => readProjectFile(projectDir, "comment.md"))
      .toMatch(
        /The \{==rollout needs a date==\}\{>>Which week\?<<\}\{id="c1" by="user" at="[^"]+"\}\./,
      );
    logE2eEvent("orca-mobile.comment-added", { file: "comment.md" });
  });

  test("opens a comment from its highlight and replies to it", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "reply.md",
      [
        "# Reply",
        "",
        'Ship {==on Friday==}{>>Is Friday realistic?<<}{id="c1" by="AI" at="2026-10-01T10:00:00.000Z"}.',
        "",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath);
    const phone = await orcaMobile(page);
    const sheet = page.getByTestId("document-review-sheet");

    await expect(sheet).toHaveCount(0);
    await phone.tapElement(page.locator(".comment-anchor[data-comment-ids]"));
    await expect(sheet).toContainText("Is Friday realistic?");

    await phone.tapElement(sheet.getByTestId("comment-rail-c1-action-reply"));
    const replyEditor = sheet.getByTestId("comment-rail-c2-editor");
    await expect(replyEditor).toBeVisible();
    await phone.tapElement(replyEditor);
    await phone.type("Yes, QA signed off.");
    await phone.tapElement(sheet.getByTestId("comment-rail-c2-action-save"));

    await expect
      .poll(() => readProjectFile(projectDir, "reply.md"))
      .toMatch(
        /\{>>Yes, QA signed off\.<<\}\{id="c2" by="user" at="[^"]+" re="c1"\}/,
      );

    await phone.tapElement(sheet.getByTestId("document-review-sheet-close"));
    await expect(sheet).toHaveCount(0);
  });

  test("steps to a suggestion with the navigator and accepts it", async ({
    page,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "suggestion.md",
      [
        "# Suggestion",
        "",
        'Launch {++next++}{id="s1" by="AI" at="2026-10-01T10:00:00.000Z"} week.',
        "",
      ].join("\n"),
    );
    await openMarkdownFile(page, filePath);
    const phone = await orcaMobile(page);

    await phone.tapElement(page.getByTestId("review-navigator-next"));
    const sheet = page.getByTestId("document-review-sheet");
    await expect(sheet).toContainText("next");
    await phone.tapElement(sheet.getByTestId("comment-rail-s1-action-accept"));

    await expect
      .poll(() => readProjectFile(projectDir, "suggestion.md"))
      .toBe("# Suggestion\n\nLaunch next week.\n");
  });

  test("hands the review back with I'm done", async ({ page, request }) => {
    const filePath = writeProjectFile(
      projectDir,
      "handoff.md",
      ["# Handoff", "", "Ready for the agent.", ""].join("\n"),
    );
    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: "handoff.md", timeoutSeconds: 10 },
    });
    await openMarkdownFile(page, filePath);
    const phone = await orcaMobile(page);

    const handoffButton = page.getByTestId("review-handoff-button");
    await expect(handoffButton).toBeVisible();
    // The header must clear the fixed button so both stay tappable.
    const header = await page.getByTestId("document-page-header").boundingBox();
    const button = await handoffButton.boundingBox();
    expect((button?.y ?? 0) + (button?.height ?? 0)).toBeLessThanOrEqual(
      header?.y ?? 0,
    );

    await phone.tapElement(handoffButton);

    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Your agent is now working",
    );
    const watchResponse = (await pendingWatch) as {
      json: () => Promise<{ events: Array<{ type: string }> }>;
    };
    expect((await watchResponse.json()).events).toMatchObject([
      { type: "review.completed" },
    ]);
  });
});
