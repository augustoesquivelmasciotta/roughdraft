import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const markdown = [
  "# Guard",
  "",
  "<details><summary>Changelog</summary>",
  "",
  "- First change",
  "",
  "</details>",
  "",
  "After the section.",
  "",
].join("\n");

test.describe("a raw block in editing mode", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("raw-block-guard");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("refuses a Backspace that would delete a <details> section and lets typing go on @smoke", async ({
    page,
  }) => {
    const filePath = writeProjectFile(projectDir, "guard.md", markdown);
    await openMarkdownFile(page, filePath, "rich-text");
    await page.getByTestId("document-mode-trigger").click();
    await page.getByTestId("document-mode-option-editing").click();
    await expect(page.getByTestId("document-mode-trigger")).toContainText(
      "Editing",
    );

    const editor = richTextEditor(page);
    await editor.getByText("After the section.").click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");

    await expect(
      editor.getByTestId("unrendered-block-deletion-refused"),
    ).toContainText("Rich text will not delete this details block");
    await expect(editor.locator("details")).toBeVisible();

    await page.keyboard.type("Typed ");
    await expect(editor).toContainText("Typed After the section.");
    await expect(
      editor.getByTestId("unrendered-block-deletion-refused"),
    ).toHaveCount(0);
    await expect
      .poll(() => readProjectFile(projectDir, "guard.md"))
      .toContain("Typed After the section.");
    expect(readProjectFile(projectDir, "guard.md")).toContain(
      "<details><summary>Changelog</summary>",
    );
  });
});
