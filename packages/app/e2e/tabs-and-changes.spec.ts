import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { replyToComment } from "../../server/src/review-comments";
import {
  createMarkdownProject,
  installCloseWindowRecorder,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

interface WatchPayload {
  timedOut?: boolean;
  events: Array<{
    type: string;
    comments?: Array<{ text: string; kind: string }>;
  }>;
}

test.describe("tab window, change highlighting and live comments", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("tabs-and-changes");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("reviews two documents as tabs and finishes the first with I'm done @smoke", async ({
    page,
    request,
  }) => {
    const firstPath = writeProjectFile(
      projectDir,
      "first-doc.md",
      ["# First Doc", "", "Review the first document.", ""].join("\n"),
    );
    const secondPath = writeProjectFile(
      projectDir,
      "second-doc.md",
      ["# Second Doc", "", "Review the second document.", ""].join("\n"),
    );

    const opened = await request.post("/api/tabs/open", {
      data: {
        tabs: [{ path: firstPath }, { path: secondPath }],
        now: true,
      },
    });
    expect(opened.ok()).toBe(true);
    const { url } = (await opened.json()) as { url?: string };
    expect(url).toContain("/tabs");

    // Keeps «I'm done» visible for the first document, like the agent's
    // blocking `roughdraft open` does.
    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: "first-doc.md",
        timeoutSeconds: 20,
      },
    });

    await installCloseWindowRecorder(page);
    await page.goto(url as string);

    const firstTab = page.getByTestId(`tab-window-tab-${firstPath}`);
    const secondTab = page.getByTestId(`tab-window-tab-${secondPath}`);
    await expect(firstTab).toContainText("first-doc.md");
    await expect(secondTab).toContainText("second-doc.md");
    await expect(firstTab).toHaveAttribute("data-active", "true");

    // Only the active tab has a page; the other one is built on first click.
    await expect(
      page.getByTestId(`tab-window-frame-${firstPath}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`tab-window-frame-${secondPath}`),
    ).toHaveCount(0);

    const firstFrame = page
      .getByTestId(`tab-window-frame-${firstPath}`)
      .contentFrame();
    const handoff = firstFrame.getByTestId("review-handoff-button");
    await expect(handoff).toBeVisible();
    await handoff.click();

    await expect(
      page.getByTestId(`tab-window-done-${firstPath}`),
    ).toBeVisible();
    await expect(firstTab).toHaveCount(0);
    await expect(secondTab).toHaveAttribute("data-active", "true");
    await expect(
      page.getByTestId(`tab-window-frame-${secondPath}`),
    ).toBeVisible();
    await expect(page.getByTestId("tab-window-progress")).toHaveCount(0);

    const payload = (await (
      (await pendingWatch) as { json: () => Promise<WatchPayload> }
    ).json()) as WatchPayload;
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      type: "review.completed",
      relativePath: "first-doc.md",
    });
  });

  test("highlights what changed since the last review and leaves no trace in the file", async ({
    page,
    request,
  }) => {
    const relativePath = "changes.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      [
        "# Changes",
        "",
        "The first paragraph never changes.",
        "",
        "The second paragraph has an old claim in it.",
        "",
        "The third paragraph never changes either.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("second paragraph");
    await expect(page.getByTestId("change-highlight-controls")).toHaveCount(0);

    // A delivered review starts a new round: its snapshot is the baseline.
    const delivered = await request.post("/api/review-events", {
      data: { projectPath: projectDir, path: relativePath },
    });
    expect(delivered.status()).toBe(201);

    fs.writeFileSync(
      filePath,
      [
        "# Changes",
        "",
        "The first paragraph never changes.",
        "",
        "The second paragraph has a corrected claim in it.",
        "",
        "The third paragraph never changes either.",
        "",
        "A brand new fourth paragraph was added by the agent.",
        "",
      ].join("\n"),
    );

    await expect(page.getByTestId("change-highlight-count")).toHaveText(
      "2 changes",
    );
    const blocks = richTextEditor(page).getByTestId("change-block");
    await expect(blocks).toHaveCount(2);
    await expect(blocks.nth(0)).toContainText("corrected claim");
    await expect(blocks.nth(0)).toHaveAttribute("data-change-kind", "changed");
    await expect(blocks.nth(1)).toContainText("brand new fourth paragraph");
    await expect(blocks.nth(1)).toHaveAttribute("data-change-kind", "added");

    const toggle = page.getByTestId("change-highlight-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(blocks).toHaveCount(0);
    await toggle.click();
    await expect(blocks).toHaveCount(2);

    // A further edit and save: the highlight is a view, never file content.
    await richTextEditor(page).getByText("never changes either.").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Edited by the reviewer.");
    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toContain("Edited by the reviewer.");
    const saved = readProjectFile(projectDir, relativePath);
    expect(saved).not.toMatch(/change-block|change-word|rd-change|data-change/);
    // The reviewer's own edit is the only review mark: one suggestion, and
    // no comment or highlight for the agent's changes.
    expect(saved.match(/\{\+\+/g)).toHaveLength(1);
    expect(saved).not.toMatch(/\{(?:==|--|~~|>>)/);
    expect(saved).toContain("A brand new fourth paragraph was added");
  });

  test("delivers a live comment to the watch and shows an agent reply without a reload", async ({
    page,
    request,
  }) => {
    const relativePath = "live-comment.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      [
        "# Live Comment",
        "",
        "This paragraph has target text to review.",
        "",
      ].join("\n"),
    );
    const commentText = "Clarify this phrase.";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 20,
        batchWindowSeconds: 1,
        includeComments: true,
      },
    });

    await openMarkdownFile(page, filePath);
    await selectRichText(page, "target text");
    await page.getByTestId("selection-menu-action-comment").click();
    await page.getByTestId("comment-rail-c1-editor").fill(commentText);
    await page.getByTestId("comment-rail-c1-action-save").click();

    const payload = (await (
      (await pendingWatch) as { json: () => Promise<WatchPayload> }
    ).json()) as WatchPayload;
    pendingWatch = null;
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]?.type).toBe("comment.added");
    expect(payload.events[0]?.comments?.[0]).toMatchObject({
      kind: "comment",
      text: commentText,
    });

    // The agent answers with the same write `roughdraft reply` does.
    const reply = replyToComment(filePath, {
      parentId: "c1",
      message: "Reworded it in the next paragraph.",
    });
    expect(reply.parentId).toBe("c1");

    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Reworded it in the next paragraph.",
    );
  });
});
