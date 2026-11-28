import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";

describe("GET /api/document-baseline", () => {
  let projectDir: string;
  let homeDir: string;
  let outsideDir: string;

  beforeEach(() => {
    // realpath: os.tmpdir() is a symlink on macOS and git reports real paths.
    projectDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-baseline-")),
    );
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-home-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-out-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const makeApp = () => createApp({ homeDir, staticDirPath: projectDir }).app;
  const baseline = (
    app: ReturnType<typeof makeApp>,
    since?: string,
    docPath = "draft.md",
  ) =>
    request(app)
      .get("/api/document-baseline")
      .query({
        projectPath: projectDir,
        path: docPath,
        ...(since === undefined ? {} : { since }),
      });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: projectDir, stdio: "pipe" },
    );

  it("on first open the last-review baseline equals the document", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n\nOne.\n");
    const app = makeApp();

    const explicit = await baseline(app, "last-review");
    const absent = await baseline(app);

    expect(explicit.status).toBe(200);
    expect(explicit.body).toMatchObject({
      source: "last-review",
      content: "# Draft\n\nOne.\n",
    });
    expect(absent.body.content).toBe("# Draft\n\nOne.\n");
  });

  it("after a review completes the baseline is the text at that point, not later edits", async () => {
    const filePath = path.join(projectDir, "draft.md");
    fs.writeFileSync(filePath, "# Draft\n\nOne.\n");
    const app = makeApp();
    await baseline(app);

    await request(app)
      .put("/api/markdown-file")
      .query({ projectPath: projectDir, path: "draft.md" })
      .send({ content: "# Draft\n\nTwo.\n" });
    await request(app)
      .post("/api/review-events")
      .send({ projectPath: projectDir, path: "draft.md" });
    await request(app)
      .put("/api/markdown-file")
      .query({ projectPath: projectDir, path: "draft.md" })
      .send({ content: "# Draft\n\nThree.\n" });

    const response = await baseline(app, "last-review");
    expect(response.body.content).toBe("# Draft\n\nTwo.\n");
  });

  it("reads a file baseline, relative to the document's directory or absolute", async () => {
    fs.mkdirSync(path.join(projectDir, "notes"));
    fs.writeFileSync(path.join(projectDir, "notes", "doc.md"), "# New\n");
    fs.writeFileSync(path.join(projectDir, "notes", "old.md"), "# Old\n");
    const app = makeApp();

    const relative = await baseline(app, "old.md", "notes/doc.md");
    const absolute = await baseline(
      app,
      path.join(projectDir, "notes", "old.md"),
      "notes/doc.md",
    );

    expect(relative.status).toBe(200);
    expect(relative.body).toEqual({
      source: "file",
      label: path.join("notes", "old.md"),
      content: "# Old\n",
    });
    expect(absolute.body.content).toBe("# Old\n");
  });

  it("refuses a baseline file outside the project", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n");
    const secret = path.join(outsideDir, "secret.md");
    fs.writeFileSync(secret, "secret");
    fs.symlinkSync(secret, path.join(projectDir, "link.md"));
    const app = makeApp();

    for (const since of [
      secret,
      `../${path.basename(outsideDir)}`,
      "link.md",
    ]) {
      const response = await baseline(app, since);
      expect(response.status, since).toBeGreaterThanOrEqual(400);
    }
    expect((await baseline(app, secret)).status).toBe(403);
    expect((await baseline(app, "link.md")).status).toBe(403);
  });

  it("reads a git ref baseline of the document in its repository", async () => {
    fs.mkdirSync(path.join(projectDir, "sub"));
    const doc = path.join(projectDir, "sub", "draft.md");
    fs.writeFileSync(doc, "# Draft\n\nCommitted.\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    fs.writeFileSync(doc, "# Draft\n\nCommitted.\n\nUncommitted.\n");
    const app = makeApp();

    const response = await baseline(app, "HEAD", "sub/draft.md");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      source: "git",
      label: "git HEAD",
      content: "# Draft\n\nCommitted.\n",
    });
  });

  it("answers 404 for an unknown ref and for a document not in the ref", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    fs.writeFileSync(path.join(projectDir, "later.md"), "# Later\n");
    const app = makeApp();

    expect((await baseline(app, "no-such-ref")).status).toBe(404);
    const missing = await baseline(app, "HEAD", "later.md");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("HEAD");
  });

  it("refuses refs that look like options or reach another path", async () => {
    fs.writeFileSync(path.join(projectDir, "draft.md"), "# Draft\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    const app = makeApp();

    for (const since of [
      "--output=/tmp/x",
      "-p",
      "HEAD:draft.md",
      "HEAD draft",
    ]) {
      const response = await baseline(app, since);
      expect(response.status, since).toBe(400);
    }
  });

  it("answers 404 for a document that does not exist", async () => {
    const app = makeApp();
    expect((await baseline(app, "last-review", "missing.md")).status).toBe(404);
  });
});
