import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  routeApiTo,
  startReplacementServer,
  writeProjectFile,
} from "./helpers";

// The agent's blocking `roughdraft open` is stood in for by a watch request:
// the one on the first server is the watch the restart interrupts, and the
// one on the replacement is the reconnected watch. The notice under the
// "I'm done" button appears only after a few lost polls, so it waits longer.
const noticeTimeout = 15_000;

test.describe("review across a server restart", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("review-restart");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("keeps I'm done through a restart and delivers it to the reconnected watch @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "restart.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      ["# Restart", "", "Review this across a restart.", ""].join("\n"),
    );
    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: relativePath, timeoutSeconds: 5 },
    });

    await openMarkdownFile(page, filePath);
    const button = page.getByTestId("review-handoff-button");
    await expect(button).toBeVisible();
    await expect(page.getByTestId("rich-text-editor")).toContainText(
      "Review this across a restart.",
    );

    const replacement = await startReplacementServer(projectDir);
    try {
      await routeApiTo(page, replacement.port);

      await expect(page.getByTestId("review-watcher-notice")).toContainText(
        "Agent disconnected",
        { timeout: noticeTimeout },
      );
      await expect(button).toBeVisible();
      // The document is still there and still saves, now to the new server.
      await richTextEditor(page).click();
      await page.keyboard.press("End");
      await page.keyboard.type(" Edited after the restart.");
      await expect
        .poll(() => readProjectFile(projectDir, relativePath))
        .toContain("Edited after the restart.");

      const reconnectedWatch = request.post(
        `http://127.0.0.1:${replacement.port}/api/review-events/watch`,
        {
          data: {
            projectPath: projectDir,
            path: relativePath,
            timeoutSeconds: 10,
          },
        },
      );
      await expect(page.getByTestId("review-watcher-notice")).toBeHidden();

      await button.click();
      await expect(button).toHaveText("Sent");

      const payload = await (await reconnectedWatch).json();
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]).toMatchObject({
        type: "review.completed",
        relativePath,
      });
    } finally {
      await replacement.close();
    }
  });

  test("names the state while the server is unreachable and when no agent comes back", async ({
    page,
    request,
  }) => {
    const relativePath = "orphaned.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      ["# Orphaned", "", "Nobody is coming back for this one.", ""].join("\n"),
    );
    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: relativePath, timeoutSeconds: 5 },
    });

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();

    const statusRoute = "**/api/review-events/status**";
    await page.route(statusRoute, (route) => route.abort());
    await expect(page.getByTestId("review-watcher-notice")).toContainText(
      "Roughdraft server unreachable",
      { timeout: noticeTimeout },
    );
    await page.unroute(statusRoute);

    const replacement = await startReplacementServer(projectDir);
    try {
      await routeApiTo(page, replacement.port);

      const notice = page.getByTestId("review-watcher-notice");
      await expect(notice).toContainText("Agent disconnected", {
        timeout: noticeTimeout,
      });
      await expect(notice).toContainText("roughdraft open");

      await page.getByTestId("review-handoff-button").click();
      await expect(page.getByTestId("review-handoff-status")).toContainText(
        "No agent is watching now",
      );
      await expect(page.getByTestId("review-handoff-status")).toContainText(
        "roughdraft open",
      );
    } finally {
      await replacement.close();
    }
  });

  test("saves an edit made while the server was down once it answers again", async ({
    page,
    request,
  }) => {
    const relativePath = "offline.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      ["# Offline", "", "Edit me while the server is away.", ""].join("\n"),
    );
    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: relativePath, timeoutSeconds: 5 },
    });
    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();

    await page.route("**/api/**", (route) => route.abort());
    await richTextEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Typed offline.");
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Save failed",
      { timeout: noticeTimeout },
    );

    await page.unroute("**/api/**");

    await expect
      .poll(() => readProjectFile(projectDir, relativePath), {
        timeout: noticeTimeout,
      })
      .toContain("Typed offline.");
  });
});
