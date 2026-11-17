import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  createMarkdownProject,
  documentSaveStatus,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("Descartar cambios", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("review-discard");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("restores the document as it was when the round started, with a two-step confirm", async ({
    page,
  }) => {
    const original = "# Discard\n\nOriginal text.\n";
    const filePath = writeProjectFile(projectDir, "discard.md", original);
    page.on("dialog", () => {
      throw new Error("a browser confirm dialog opened");
    });

    await openMarkdownFile(page, filePath, "code");
    await expect(page.getByTestId("markdown-code-editor")).toBeVisible();

    // Unchanged: the action is not offered.
    await page.getByTestId("document-file-menu-trigger").click();
    await expect(page.getByTestId("document-file-menu")).toBeVisible();
    await expect(
      page.getByTestId("document-file-menu-discard-changes"),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("document-file-menu")).toBeHidden();

    await appendInCodeEditor(page, "\nReviewer edit.\n");
    await expect
      .poll(() => readProjectFile(projectDir, "discard.md"))
      .toContain("Reviewer edit.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );

    await page.getByTestId("document-file-menu-trigger").click();
    const discard = page.getByTestId("document-file-menu-discard-changes");
    await expect(discard).toHaveText("Descartar cambios");

    // First click only arms it; it lapses after 4 seconds.
    await discard.click();
    await expect(discard).toHaveText("¿Descartar todo? Tocá de nuevo");
    await expect(discard).toHaveText("Descartar cambios", { timeout: 6000 });
    expect(readProjectFile(projectDir, "discard.md")).toContain(
      "Reviewer edit.",
    );

    // Two clicks within the window restore it.
    await discard.click();
    await discard.click();
    await expect
      .poll(() => readProjectFile(projectDir, "discard.md"))
      .toBe(original);
    await expect(page.getByTestId("markdown-code-editor")).not.toContainText(
      "Reviewer edit.",
    );

    // Give autosave time to prove it does not write the old text back.
    await page.waitForTimeout(1500);
    expect(readProjectFile(projectDir, "discard.md")).toBe(original);
  });
});
