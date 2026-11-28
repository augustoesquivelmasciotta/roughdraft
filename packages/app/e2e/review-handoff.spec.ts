import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("review handoff", () => {
  let projectDir: string;
  let pendingWatch: Promise<unknown> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("review-handoff");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  test("persists an overall handoff comment from the primary done button to YAML endmatter @smoke", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "handoff-comment.md",
      ["# Handoff Comment", "", "Review this document.", ""].join("\n"),
    );
    const relativePath = "handoff-comment.md";
    const overallComment = "Please prioritize the CLI contract.";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();

    await page.getByTestId("review-handoff-comment-trigger").click();
    await page
      .getByTestId("review-handoff-overall-comment")
      .fill(overallComment);
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Your agent is now working",
    );

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toMatch(
        /---\ncomments:\n {2}c1:\n {4}body: Please prioritize the CLI contract\.\n {4}by: user\n {4}at: [^\n]+\n?$/,
      );

    const watchResponse = await pendingWatch;
    const payload = await watchResponse.json();
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      type: "review.completed",
      overallComment,
      summary: {
        comments: 1,
      },
    });
  });

  test("Cmd+D sends I'm done without opening the browser bookmark dialog @smoke", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "shortcut-handoff.md",
      ["# Shortcut Handoff", "", "Review this document.", ""].join("\n"),
    );

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: "shortcut-handoff.md",
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();
    await page.evaluate(() => {
      const log: boolean[] = [];
      (window as unknown as { handoffKeyLog: boolean[] }).handoffKeyLog = log;
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key.toLowerCase() === "d") log.push(event.defaultPrevented);
        },
        { capture: true },
      );
    });

    await page.getByTestId("rich-text-editor").click();
    // The shortcut follows the platform the page sees (Playwright's desktop
    // device reports Windows): ⌘D on macOS, Ctrl+D elsewhere.
    const isApplePlatform = await page.evaluate(() =>
      /mac|iphone|ipad|ipod/i.test(navigator.platform),
    );
    await page.keyboard.press(isApplePlatform ? "Meta+d" : "Control+d");

    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");
    expect(
      await page.evaluate(
        () => (window as unknown as { handoffKeyLog: boolean[] }).handoffKeyLog,
      ),
    ).toEqual([true]);
    const payload = await (
      (await pendingWatch) as { json: () => Promise<{ events: unknown[] }> }
    ).json();
    expect(payload.events).toHaveLength(1);
  });

  test("Cmd+Enter in the overall comment box submits the handoff with the comment", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "comment-shortcut.md",
      ["# Comment Shortcut", "", "Review this document.", ""].join("\n"),
    );
    const overallComment = "Ship it after the intro is shorter.";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: "comment-shortcut.md",
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await page.getByTestId("review-handoff-comment-trigger").click();
    await page
      .getByTestId("review-handoff-overall-comment")
      .fill(overallComment);
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
    );

    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");
    await expect
      .poll(() => readProjectFile(projectDir, "comment-shortcut.md"))
      .toContain(overallComment);
    const payload = await (
      (await pendingWatch) as {
        json: () => Promise<{ events: Array<{ overallComment?: string }> }>;
      }
    ).json();
    expect(payload.events[0]?.overallComment).toBe(overallComment);
  });

  test("applies a pending approval in the handoff save by resolving its thread @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "approve-reply.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      [
        "# Approve Reply",
        "",
        'This paragraph has {==target text==}{>>Needs detail<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}{>>First answer<<}{id="c2" by="AI" at="2026-04-23T18:01:00.000Z" re="c1"}{>>Newest answer<<}{id="c3" by="AI" at="2026-04-23T18:02:00.000Z" re="c1"}.',
        "",
      ].join("\n"),
    );

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    const rail = page.getByTestId("document-review-rail");
    await expect(rail.getByTestId("comment-rail-c3")).toBeVisible();

    await page.getByTestId("comment-thread-c1").click();
    await rail.getByTestId("comment-rail-c3-action-approve").click();
    await expect(
      rail.getByTestId("comment-rail-c3-approve-confirm"),
    ).toContainText("Approve");
    await rail.getByTestId("comment-rail-c3-action-approve-confirm").click();
    await expect(
      rail.getByTestId("comment-rail-c3-approval-pending"),
    ).toBeVisible();

    // Autosave debounces at 500ms; a pending approval must outlast that
    // without touching the file.
    await page.waitForTimeout(1200);
    expect(readProjectFile(projectDir, relativePath)).toContain(
      "Newest answer",
    );

    await expect(page.getByTestId("review-handoff-button")).toBeVisible();
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Your agent is now working",
    );

    await expect
      .poll(() => readProjectFile(projectDir, relativePath))
      .toContain('status="resolved"');
    const savedMarkdown = readProjectFile(projectDir, relativePath);
    expect(savedMarkdown).toContain(
      '{>>Needs detail<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z" status="resolved"}',
    );
    expect(savedMarkdown).toContain("First answer");
    expect(savedMarkdown).toContain("Newest answer");
    await expect(
      rail.getByTestId("comment-rail-c1-resolved-badge"),
    ).toBeVisible();

    const watchResponse = await pendingWatch;
    const payload = await watchResponse.json();
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({ type: "review.completed" });

    logE2eEvent("review-handoff.pending-approval-applied", {
      file: relativePath,
    });
  });

  test("closes the window after a delivered handoff without the Close window popup", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "close-on-done.md",
      ["# Close On Done", "", "Review then close.", ""].join("\n"),
    );

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: "close-on-done.md",
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __roughdraftCloseCalls?: number })
              .__roughdraftCloseCalls,
        ),
      )
      .toBe(1);
    // This test server has no Orca tab to close, so the page is still here
    // and shows how to close it; the success popup never appeared before that.
    await expect(
      page.getByTestId("review-handoff-close-window-hint"),
    ).toBeVisible();

    await pendingWatch;
  });

  test("reopens the sent handoff status from the muted primary button", async ({
    page,
    request,
  }) => {
    const filePath = writeProjectFile(
      projectDir,
      "sent-handoff.md",
      ["# Sent Handoff", "", "Review already completed.", ""].join("\n"),
    );
    const relativePath = "sent-handoff.md";

    pendingWatch = request.post("/api/review-events/watch", {
      data: {
        projectPath: projectDir,
        path: relativePath,
        timeoutSeconds: 10,
      },
    });

    await openMarkdownFile(page, filePath);
    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-button")).toHaveText("Sent");
    await expect(page.getByTestId("review-handoff-status")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("review-handoff-status")).toBeHidden();

    await page.getByTestId("review-handoff-button").click();

    await expect(page.getByTestId("review-handoff-status")).toBeVisible();
    logE2eEvent("review-handoff.sent-button-reopened-status", {
      buttonLabel: await page.getByTestId("review-handoff-button").innerText(),
    });

    await pendingWatch;
  });
});
