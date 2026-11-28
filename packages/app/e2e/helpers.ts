import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { createApp } from "../../server/src/index";

export function createMarkdownProject(label: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `roughdraft-${label}-`));
}

export function removeMarkdownProject(projectDir: string) {
  fs.rmSync(projectDir, { recursive: true, force: true });
}

export function writeProjectFile(
  projectDir: string,
  relativePath: string,
  content: string | Buffer,
) {
  const absolutePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  return absolutePath;
}

export function readProjectFile(projectDir: string, relativePath: string) {
  return fs.readFileSync(path.join(projectDir, relativePath), "utf8");
}

export async function openMarkdownFile(
  page: Page,
  absolutePath: string,
  editor?: "rich-text" | "code",
) {
  const params = new URLSearchParams({ path: absolutePath });
  if (editor) params.set("editor", editor);

  await installCloseWindowRecorder(page);
  await page.goto(`/?${params.toString()}`);
}

/**
 * A delivered Done Reviewing closes the window. A test page must survive it,
 * so `window.close` only counts its calls, like an Orca tab that ignores it;
 * the count is `window.__roughdraftCloseCalls`.
 */
export async function installCloseWindowRecorder(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as { __roughdraftCloseCalls?: number };
    target.__roughdraftCloseCalls = 0;
    window.close = () => {
      target.__roughdraftCloseCalls = (target.__roughdraftCloseCalls ?? 0) + 1;
    };
  });
}

export function codeEditor(page: Page) {
  return page.getByTestId("markdown-code-editor").locator(".cm-content");
}

export function richTextEditor(page: Page) {
  return page.getByTestId("rich-text-editor").locator(".ProseMirror");
}

export function documentSaveStatus(page: Page) {
  return page.getByTestId("document-save-status");
}

export function fileConflictNotice(page: Page) {
  return page.getByTestId("file-conflict-notice");
}

export async function appendInCodeEditor(page: Page, text: string) {
  const editor = codeEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+End" : "Control+End",
  );
  await page.keyboard.type(text);
}

export async function selectRichText(page: Page, text: string) {
  await richTextEditor(page).focus();
  await page.evaluate((targetText) => {
    const editor = document.querySelector(".ProseMirror");
    if (!editor) {
      throw new Error("Could not find rich-text editor");
    }

    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      const index = node.textContent?.indexOf(targetText) ?? -1;

      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + targetText.length);

        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return;
      }

      node = walker.nextNode();
    }

    throw new Error(`Could not find text "${targetText}"`);
  }, text);
}

export function logE2eEvent(event: string, data: Record<string, unknown> = {}) {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/app/e2e",
      event,
      data,
    })}\n`,
  );
}

interface ListeningApp {
  port: number;
  close: () => Promise<void>;
}

async function listenApp(
  app: ReturnType<typeof createApp>["app"],
  port: number,
): Promise<ListeningApp> {
  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(port, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A fresh server on another port stands in for a stopped server and a later
 * `roughdraft start`: same files, a new event queue and instance.
 */
export async function startReplacementServer(projectDir: string) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-home-"));
  const { app } = createApp({ homeDir, staticDirPath: projectDir });
  const listening = await listenApp(app, 0);
  return {
    port: listening.port,
    close: async () => {
      await listening.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

/** Sends every API call the page makes from now on to another server. */
export async function routeApiTo(page: Page, port: number) {
  await page.route("**/api/**", async (route) => {
    const original = new URL(route.request().url());
    try {
      const response = await route.fetch({
        url: `http://127.0.0.1:${port}${original.pathname}${original.search}`,
      });
      await route.fulfill({ response });
    } catch {
      // The replacement was closed (or is not up yet): to the page that is a
      // refused connection, not a test failure.
      await route.abort().catch(() => undefined);
    }
  });
}
