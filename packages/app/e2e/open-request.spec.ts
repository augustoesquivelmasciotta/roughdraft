import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("document path, session label and a second open", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("open-request");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("shows the path and the session that opened the document @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", "# Plan\n");

    await page.goto(
      `/?${new URLSearchParams({ path: filePath, label: "plan-review" })}`,
    );

    await expect(page.getByTestId("document-path")).toHaveText(filePath);
    await expect(page.getByTestId("document-path")).toHaveAttribute(
      "title",
      filePath,
    );
    await expect(page.getByTestId("document-session-label")).toHaveText(
      "Opened by plan-review",
    );
    // The file name still comes first in the window title (f7d97af).
    await expect(page).toHaveTitle(/^plan\.md/);
  });

  test("says no session label was given", async ({ page }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", "# Plan\n");

    await page.goto(`/?${new URLSearchParams({ path: filePath })}`);

    await expect(page.getByTestId("document-session-label")).toHaveText(
      "No session label",
    );
  });

  test("takes over the label in place and warns when another session opens the same document", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", "# Plan\n");
    await page.goto(
      `/?${new URLSearchParams({ path: filePath, label: "plan-review" })}`,
    );
    await expect(page.getByTestId("document-session-label")).toHaveText(
      "Opened by plan-review",
    );
    // A marker that a reload would wipe.
    await page.evaluate(() => {
      (window as unknown as { __stayed?: boolean }).__stayed = true;
    });

    const url = new URL(page.url());
    url.searchParams.set("label", "spec-edit");
    await expect
      .poll(async () => {
        const response = await page.request.post("/api/open-request", {
          data: { path: filePath, url: url.href, label: "spec-edit" },
        });
        return ((await response.json()) as { delivered?: boolean }).delivered;
      })
      .toBe(true);

    const notice = page.getByTestId("document-reopened-notice");
    await expect(notice).toContainText("spec-edit opened this document again");
    await expect(notice).toContainText("This tab was opened by plan-review.");
    await expect(page.getByTestId("document-session-label")).toHaveText(
      "Opened by spec-edit",
    );
    expect(new URL(page.url()).searchParams.get("label")).toBe("spec-edit");
    expect(
      await page.evaluate(
        () => (window as unknown as { __stayed?: boolean }).__stayed,
      ),
    ).toBe(true);

    await page.getByTestId("document-reopened-dismiss").click();
    await expect(notice).toHaveCount(0);
  });

  test("stays quiet when the same session reopens its document", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "plan.md", "# Plan\n");
    await page.goto(
      `/?${new URLSearchParams({ path: filePath, label: "plan-review" })}`,
    );
    await expect(page.getByTestId("document-session-label")).toHaveText(
      "Opened by plan-review",
    );

    await expect
      .poll(async () => {
        const response = await page.request.post("/api/open-request", {
          data: { path: filePath, url: page.url(), label: "plan-review" },
        });
        return ((await response.json()) as { delivered?: boolean }).delivered;
      })
      .toBe(true);
    // Give the tab a poll cycle to handle the request.
    await page.waitForTimeout(2_500);

    await expect(page.getByTestId("document-reopened-notice")).toHaveCount(0);
  });
});
