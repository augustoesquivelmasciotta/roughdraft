import crypto from "node:crypto";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendRoughdraftDocumentComment,
  extractRoughdraftReviewIndex,
} from "@roughdraft/rfm";
import express, { type Express, type Request, type Response } from "express";
import { resolveDocumentBaseline } from "./document-baseline.js";
import {
  hasNonLoopbackHost,
  isLoopbackHost,
  ROUGHDRAFT_DEFAULT_PORT,
  ROUGHDRAFT_PUBLIC_HOST,
  resolveBindHosts,
} from "./network.js";
import {
  closeOrcaTabShowing,
  isSameRoughdraftDocument,
  openOrcaTab,
  type RunOrcaCommand,
  runOrcaCommand,
} from "./orca.js";
import { detectNewReviewerComments } from "./review-comments.js";
import { ReviewEventQueue } from "./review-events.js";
import { ReviewRoundStore } from "./review-round.js";
import {
  reviewFailureStatus,
  reviewSuccessStatus,
  writeReviewStatus,
} from "./review-status.js";
import {
  type OpenTabWindow,
  type OrcaTargetSnapshot,
  type TabState,
  TabWindowRegistry,
} from "./tab-windows.js";
import { resolveUpdateStatus } from "./update-status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, "../../app/dist");
const defaultServerRoot = path.resolve(__dirname, "../../..");

interface AssetPayload {
  filename?: string;
  mimeType?: string;
  dataBase64?: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

interface DirectoryListing {
  path: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
}

interface FileSystemEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

interface FileSystemListing {
  path: string;
  displayPath: string;
  parentPath: string | null;
  directories: FileSystemEntry[];
  files: FileSystemEntry[];
}

interface ProjectTreeListing {
  paths: string[];
}

interface CreateAppOptions {
  port?: number;
  projectDir?: string;
  serverRoot?: string;
  homeDir?: string;
  /** Where the server keeps its state between runs. Defaults under homeDir. */
  stateDir?: string;
  staticDirPath?: string;
  packageJsonPath?: string;
  fetchImpl?: typeof fetch;
  packageName?: string;
  remoteDocumentToken?: string;
  /** How to reach the Orca CLI when a page asks to close its Orca tab. */
  orca?: { command: string; run: RunOrcaCommand };
  /**
   * Opens a tab window when a queued batch is released with no window live.
   * Defaults to an Orca tab (the target the queuing CLI saved), then the
   * system opener the CLI uses. Tests inject a stub so nothing opens.
   */
  openTabWindow?: OpenTabWindow;
  /** Read the saved tab queue and re-arm its release timer. `createServer` sets it. */
  restoreTabQueue?: boolean;
  /** Batch length in minutes; defaults to ROUGHDRAFT_TAB_BATCH_MINUTES, then 120. */
  tabBatchMinutes?: number;
}

interface CreateAppResult {
  app: Express;
  port: number;
  /** Stops the tab queue's release timer. */
  dispose: () => void;
}

// One connected tab. `path` is the document it has open (null on the
// homepage), `sessionLabel` names the agent session that opened it,
// `openedAt` is when the tab first checked in and `lastSavedAt` the last time
// this server wrote the document while the tab was connected. Together the
// tabs are the server's in-memory record of open documents; nothing of it is
// persisted, so it is empty after a restart until the tabs check in again.
interface OpenDocumentTab {
  path: string | null;
  sessionLabel: string | null;
  openedAt: string;
  lastSavedAt: string | null;
}

interface OpenRequestClient extends OpenDocumentTab {
  id: number;
  response: Response;
}

// What `/api/status` reports for each tab that has a document open.
export interface OpenDocumentRecord {
  path: string;
  sessionLabel: string | null;
  openedAt: string;
  lastSavedAt: string | null;
}

interface OpenRequestPayload {
  path?: string;
  url?: string;
  label?: string;
}

function normalizeSessionLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 200)
    : null;
}

// A tab that polls for open requests instead of holding an event stream.
interface OpenRequestPoller extends OpenDocumentTab {
  lastSeenAt: number;
  pending: Array<{ path: string; url: string; label: string | null }>;
}

// Why: a tab that stops polling (closed, crashed) must stop receiving
// requests, so a poller counts as listening only while it keeps polling.
const OPEN_REQUEST_POLLER_TTL_MS = 10_000;

interface RemoteSession {
  id: string;
  originPath: string;
  content: string;
  version: string;
  saveClient: Response | null;
  viewers: Set<Response>;
  disconnectedAt: number | null;
}

interface RemoteDocumentRegisterPayload {
  sessionId?: string;
  originPath?: string;
  content?: string;
}

interface RemoteDocumentSavePayload {
  content?: string;
  expectedVersion?: string;
}

const REMOTE_SESSION_TTL_MS = 5 * 60 * 1000;
const REMOTE_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const REMOTE_SESSION_KEEPALIVE_MS = 15 * 1000;
const MAX_OVERALL_COMMENT_LENGTH = 4_000;

let nextOpenRequestClientId = 1;

// Why: macOS can spell the same path in NFC or NFD, and a tab may report a
// relative or unnormalized spelling, so compare resolved, NFC paths.
function samePath(left: string, right: string): boolean {
  return (
    path.resolve(left).normalize("NFC") === path.resolve(right).normalize("NFC")
  );
}

function samePathOrBothNull(left: string | null, right: string | null) {
  if (left === null || right === null) return left === right;
  return samePath(left, right);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node reports IPv4 clients of a dual-stack socket as ::ffff:127.0.0.1.
  return isLoopbackHost(address.replace(/^::ffff:/i, ""));
}

function remoteSessionVersion(content: string): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return `${hash}:${crypto.randomUUID()}`;
}

function remoteSessionView(session: RemoteSession): {
  id: string;
  originPath: string;
  content: string;
  version: string;
} {
  return {
    id: session.id,
    originPath: session.originPath,
    content: session.content,
    version: session.version,
  };
}

function writeRemoteSessionEvent(
  response: Response,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function listMdFiles(projectDir: string): string[] {
  try {
    return fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

function titleFromContent(content: string, fallback: string): string {
  const firstLine = content.split("\n")[0] || "";
  return firstLine.replace(/^#*\s*/, "").trim() || fallback;
}

function fileVersionFromContent(
  stats: fs.Stats,
  content: string | Buffer,
): string {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  return `${stats.mtimeMs}:${stats.size}:${contentHash}`;
}

function fileVersionFromFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  const stats = fs.statSync(filePath);
  return fileVersionFromContent(stats, content);
}

function normalizeOverallComment(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function markdownPageFromFile(
  relativePath: string,
  absolutePath: string,
): {
  id: string;
  title: string;
  content: string;
  version: string;
} {
  const content = fs.readFileSync(absolutePath, "utf-8");
  const stats = fs.statSync(absolutePath);
  const fallbackTitle = path.basename(relativePath, ".md");

  return {
    id: pageIdFromRelativePath(relativePath),
    title: titleFromContent(content, fallbackTitle),
    content,
    version: fileVersionFromContent(stats, content),
  };
}

function pageIdFromRelativePath(relativePath: string): string {
  return relativePath.replace(/\.md$/i, "").split(path.sep).join("/");
}

function nextUntitledId(projectDir: string): string {
  const existing = listMdFiles(projectDir);
  let i = 1;
  while (existing.includes(`untitled-${i}`)) i++;
  return `untitled-${i}`;
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim() || "attachment";
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function ensureProjectPath(
  projectDir: string,
  relativePath: string,
): string | null {
  const normalized = relativePath.replace(/^\.?\//, "");
  const absolute = path.resolve(projectDir, normalized);
  const relative = path.relative(projectDir, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return absolute;
}

function pageFilePathFromId(projectDir: string, id: string): string | null {
  return ensureProjectPath(projectDir, `${id}.md`);
}

function nextAssetPath(projectDir: string, filename: string): string {
  const assetsDir = path.join(projectDir, ".roughdraft-assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const safeName = sanitizeFilename(filename);
  const extensionIndex = safeName.lastIndexOf(".");
  const basename =
    extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
  const extension = extensionIndex > 0 ? safeName.slice(extensionIndex) : "";

  let counter = 0;
  while (true) {
    const suffix = counter === 0 ? "" : `-${counter}`;
    const relativePath = `.roughdraft-assets/${basename}${suffix}${extension}`;
    const absolutePath = path.join(projectDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return relativePath;
    }
    counter += 1;
  }
}

function ensureDirectoryExists(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function listDirectories(dir: string): DirectoryListing {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(dir, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const parentPath = path.dirname(dir);

  return {
    path: dir,
    parentPath: parentPath === dir ? null : parentPath,
    directories: entries,
  };
}

function formatDisplayPath(targetPath: string, homeDir: string): string {
  const normalizedHome = path.resolve(homeDir);
  const normalizedTarget = path.resolve(targetPath);

  if (normalizedTarget === normalizedHome) {
    return "~";
  }

  const relativeToHome = path.relative(normalizedHome, normalizedTarget);
  if (!relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    return `~/${relativeToHome.split(path.sep).join("/")}`;
  }

  return normalizedTarget;
}

function listFileSystem(dir: string, homeDir: string): FileSystemListing {
  const normalizedDir = path.resolve(dir);
  const normalizedHome = path.resolve(homeDir);

  let rawEntries: fs.Dirent[];
  try {
    rawEntries = fs.readdirSync(normalizedDir, { withFileTypes: true });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "EACCES" || errorCode === "EPERM") {
      throw new Error("Directory is not readable.");
    }
    throw error;
  }

  const directories = rawEntries
    .filter((entry) => entry.isDirectory())
    .map<FileSystemEntry>((entry) => ({
      name: entry.name,
      path: path.join(normalizedDir, entry.name),
      kind: "directory",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const files = rawEntries
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"),
    )
    .map<FileSystemEntry>((entry) => ({
      name: entry.name,
      path: path.join(normalizedDir, entry.name),
      kind: "file",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return {
    path: normalizedDir,
    displayPath: formatDisplayPath(normalizedDir, normalizedHome),
    parentPath:
      normalizedDir === normalizedHome ? null : path.dirname(normalizedDir),
    directories,
    files,
  };
}

function toCanonicalRelativePath(
  projectDir: string,
  absolutePath: string,
  isDirectory: boolean,
): string {
  const relativePath = path.relative(projectDir, absolutePath);
  const canonicalPath = relativePath.split(path.sep).join("/");
  return isDirectory ? `${canonicalPath}/` : canonicalPath;
}

function listProjectTree(projectDir: string): ProjectTreeListing {
  const paths: string[] = [];

  const visitDirectory = (dir: string) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .slice()
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name, undefined, {
          numeric: true,
        });
      });

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        paths.push(toCanonicalRelativePath(projectDir, absolutePath, true));
        visitDirectory(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        paths.push(toCanonicalRelativePath(projectDir, absolutePath, false));
      }
    }
  };

  visitDirectory(projectDir);

  return { paths };
}

export function createApp(options: CreateAppOptions = {}): CreateAppResult {
  const port = options.port ?? ROUGHDRAFT_DEFAULT_PORT;
  // Names this server process. A watcher that reconnects after a restart
  // compares it to tell a new server (whose event sequence starts over) from
  // a dropped connection.
  const instanceId = crypto.randomUUID();
  const homeDir = options.homeDir ?? os.homedir();
  const serverRoot = path.resolve(options.serverRoot ?? defaultServerRoot);
  const staticDirPath = options.staticDirPath ?? staticDir;
  const fetchImpl = options.fetchImpl ?? fetch;
  const remoteDocumentToken =
    typeof options.remoteDocumentToken === "string" &&
    options.remoteDocumentToken.length > 0
      ? options.remoteDocumentToken
      : null;
  const orca = options.orca ?? {
    command: process.env.ORCA_CLI_COMMAND?.trim() || "orca",
    run: runOrcaCommand,
  };
  const app = express();
  const openRequestClients = new Set<OpenRequestClient>();
  const openRequestPollers = new Map<string, OpenRequestPoller>();
  const reviewEvents = new ReviewEventQueue();
  const stateDir =
    options.stateDir ?? path.join(homeDir, ".roughdraft", "state");
  const reviewRounds = new ReviewRoundStore(
    path.join(stateDir, "review-rounds"),
  );
  const remoteSessions = new Map<string, RemoteSession>();

  const publicOrigin = `http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`;
  const openTabWindow: OpenTabWindow =
    options.openTabWindow ??
    (async ({ url, orcaTarget }) => {
      if (orcaTarget) {
        const result = await openOrcaTab({
          target: orcaTarget,
          url,
          run: orca.run,
        });
        if (result.opened) return true;
      }
      // Loaded here, not at the top: the CLI module imports this one's peers.
      const { createDefaultOpenUrl } = await import("./cli.js");
      const mode = createDefaultOpenUrl({ env: process.env })(url);
      return mode !== "disabled" && mode !== "none";
    });
  const tabWindows = new TabWindowRegistry({
    stateDir,
    batchMinutes: options.tabBatchMinutes,
    openWindow: (request) =>
      openTabWindow({ ...request, url: `${publicOrigin}${request.url}` }),
    isShownByPlainPage: (documentPath) =>
      liveTabs().some(
        (tab) => tab.path !== null && samePath(tab.path, documentPath),
      ),
  });
  if (options.restoreTabQueue) tabWindows.restore();

  function isAuthorizedRemoteDocumentRequest(req: Request): boolean {
    if (!remoteDocumentToken) return true;

    const header =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : "";
    if (header.startsWith("Bearer ")) {
      const supplied = header.slice("Bearer ".length).trim();
      if (supplied === remoteDocumentToken) return true;
    }

    const acceptsQueryToken =
      req.method === "GET" &&
      req.path.startsWith("/api/remote-document/") &&
      req.path.endsWith("/events");
    const queryToken =
      acceptsQueryToken && typeof req.query.token === "string"
        ? req.query.token
        : "";
    return queryToken === remoteDocumentToken;
  }

  function rejectUnauthorizedRemoteDocumentRequest(res: Response): void {
    res.status(401).json({
      error:
        "Remote document endpoints require a valid token. Set ROUGHDRAFT_TOKEN on the client; browser event streams may include ?token=... in the URL.",
    });
  }

  const remoteSessionSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of remoteSessions) {
      if (
        session.disconnectedAt !== null &&
        now - session.disconnectedAt > REMOTE_SESSION_TTL_MS
      ) {
        remoteSessions.delete(id);
      }
    }
  }, REMOTE_SESSION_SWEEP_INTERVAL_MS);
  remoteSessionSweeper.unref?.();

  app.use(express.json({ limit: "50mb" }));

  function requestedProjectPath(req: Request): string | null {
    const queryPath =
      typeof req.query.projectPath === "string"
        ? req.query.projectPath.trim()
        : "";
    const bodyPath =
      typeof req.body?.projectPath === "string"
        ? req.body.projectPath.trim()
        : "";
    const nextPath = queryPath || bodyPath;
    return nextPath.length > 0 ? nextPath : null;
  }

  function projectDirFromRequest(
    req: Request,
    res: Response,
    options?: { mustExist?: boolean },
  ): string | null {
    const nextProjectPath = requestedProjectPath(req);
    if (!nextProjectPath) {
      res.status(400).json({ error: "projectPath is required" });
      return null;
    }

    const resolvedProjectDir = path.resolve(nextProjectPath);
    const mustExist = options?.mustExist ?? true;

    if (mustExist && !isExistingDirectory(resolvedProjectDir)) {
      res.status(404).json({ error: "Project directory not found" });
      return null;
    }

    return resolvedProjectDir;
  }

  function markdownPathFromRequest(
    req: Request,
    res: Response,
  ): { relativePath: string; absolutePath: string; projectDir: string } | null {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return null;

    const relativePath =
      typeof req.query.path === "string"
        ? req.query.path
        : typeof req.body?.path === "string"
          ? req.body.path
          : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return null;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return null;
    }

    return { relativePath, absolutePath, projectDir };
  }

  // --- API routes ---

  app.get("/api/pages", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const ids = listMdFiles(projectDir);
    const pages = ids.map((id) => {
      const content = fs.readFileSync(
        path.join(projectDir, `${id}.md`),
        "utf-8",
      );
      return { id, title: titleFromContent(content, id), content };
    });
    res.json(pages);
  });

  app.get("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ id, title: titleFromContent(content, id), content });
  });

  app.get("/api/markdown-file", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    const page = markdownPageFromFile(relativePath, absolutePath);
    // Opening the document starts its review round, unless one is running.
    reviewRounds.ensure(absolutePath, page.content);
    res.json(page);
  });

  app.get("/api/markdown-file/version", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    const exists = fs.existsSync(absolutePath);
    res.json({
      path: relativePath,
      exists,
      version: exists ? fileVersionFromFile(absolutePath) : null,
    });
  });

  app.get("/api/markdown-file/events", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");

    const sendChange = (stats: fs.Stats) => {
      const exists = stats.nlink > 0;
      res.write(
        `event: change\ndata: ${JSON.stringify({
          path: relativePath,
          exists,
          version: exists ? fileVersionFromFile(absolutePath) : null,
        })}\n\n`,
      );
    };

    const listener = (current: fs.Stats, previous: fs.Stats) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size &&
        current.nlink === previous.nlink
      ) {
        return;
      }

      sendChange(current);
    };

    fs.watchFile(absolutePath, { interval: 500 }, listener);

    req.on("close", () => {
      fs.unwatchFile(absolutePath, listener);
    });
  });

  app.get("/api/review-index", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const markdown = fs.readFileSync(target.absolutePath, "utf-8");
    res.json({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      fileVersion: fileVersionFromFile(target.absolutePath),
      ...extractRoughdraftReviewIndex(markdown),
    });
  });

  app.post("/api/review-events", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const overallComment = normalizeOverallComment(req.body?.overallComment);
    if (
      overallComment !== undefined &&
      overallComment.length > MAX_OVERALL_COMMENT_LENGTH
    ) {
      res.status(400).json({
        error: `overallComment must be ${MAX_OVERALL_COMMENT_LENGTH} characters or fewer`,
      });
      return;
    }

    let stage = "read-document";
    try {
      const markdown = fs.readFileSync(target.absolutePath, "utf-8");
      const persistedMarkdown = overallComment
        ? appendRoughdraftDocumentComment(markdown, {
            message: overallComment,
            author: "user",
          })
        : markdown;
      if (persistedMarkdown !== markdown) {
        stage = "save-document";
        fs.writeFileSync(target.absolutePath, persistedMarkdown);
        recordDocumentSave(target.absolutePath);
      }

      stage = "emit-event";
      const index = extractRoughdraftReviewIndex(persistedMarkdown);
      const result = reviewEvents.emit({
        documentPath: target.absolutePath,
        projectPath: target.projectDir,
        relativePath: target.relativePath,
        version: fileVersionFromFile(target.absolutePath),
        summary: index.summary,
        overallComment,
      });

      reviewRounds.reset(target.absolutePath, persistedMarkdown);
      writeReviewStatus(target.absolutePath, reviewSuccessStatus(result.event));
      res.status(201).json(result);
    } catch (error) {
      writeReviewStatus(target.absolutePath, reviewFailureStatus(stage, error));
      res.status(500).json({
        error: `Could not record the review completion (${stage})`,
      });
    }
  });

  app.get("/api/review-round", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const current = fs.readFileSync(target.absolutePath, "utf-8");
    const snapshot = reviewRounds.ensure(target.absolutePath, current);
    res.json({
      hasSnapshot: true,
      changed: snapshot.content !== current,
      startedAt: snapshot.startedAt,
    });
  });

  app.get("/api/document-baseline", async (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const since =
      typeof req.query.since === "string" ? req.query.since.trim() : "";
    if (!since || since === "last-review") {
      const current = fs.readFileSync(target.absolutePath, "utf-8");
      const snapshot = reviewRounds.ensure(target.absolutePath, current);
      res.json({
        source: "last-review",
        label: `last review (${snapshot.startedAt})`,
        content: snapshot.content,
      });
      return;
    }

    const resolved = await resolveDocumentBaseline({
      projectDir: target.projectDir,
      documentPath: target.absolutePath,
      since,
    });
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    res.json(resolved.baseline);
  });

  app.post("/api/review-round/restore", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const snapshot = reviewRounds.get(target.absolutePath);
    if (!snapshot) {
      res.status(404).json({ error: "No review round snapshot for this file" });
      return;
    }

    try {
      // The same write as a normal save, so watchers and the live view update.
      fs.writeFileSync(target.absolutePath, snapshot.content);
      recordDocumentSave(target.absolutePath);
    } catch (error) {
      res.status(500).json({
        error: `Could not restore the document: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    res.json(markdownPageFromFile(target.relativePath, target.absolutePath));
  });

  app.post("/api/review-events/watch", async (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    const fromNow = req.body?.fromNow !== false;
    const timeoutSeconds =
      typeof req.body?.timeoutSeconds === "number"
        ? req.body.timeoutSeconds
        : undefined;
    const batchWindowMs =
      typeof req.body?.batchWindowSeconds === "number"
        ? req.body.batchWindowSeconds * 1000
        : undefined;
    const afterSequence =
      typeof req.body?.afterSequence === "number" ? req.body.afterSequence : 0;
    const includeComments = req.body?.includeComments === true;

    const result = await reviewEvents.wait({
      documentPath: target.absolutePath,
      afterSequence: fromNow ? reviewEvents.latestSequence() : afterSequence,
      timeoutMs:
        timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined,
      // Left undefined, a comments-waiter gets its longer default window.
      batchWindowMs,
      includeComments,
      // A comments waiter that starts "from now" still gets the comments
      // written since the last one it was handed; an explicit afterSequence
      // (fromNow: false) is taken literally.
      catchUpComments: includeComments && fromNow,
    });

    res.json({ ...result, instanceId });
  });

  app.get("/api/review-events/status", (req, res) => {
    const target = markdownPathFromRequest(req, res);
    if (!target) return;

    // The grace period after a comments-waiter returns keeps the count at 1,
    // so the «I'm done» button stays while the agent answers.
    const watcherCount = Math.max(
      reviewEvents.waiterCountForDocument(target.absolutePath),
      reviewEvents.isDocumentWatched(target.absolutePath) ? 1 : 0,
    );
    res.json({
      documentPath: target.absolutePath,
      projectPath: target.projectDir,
      relativePath: target.relativePath,
      watching: watcherCount > 0,
      watcherCount,
      instanceId,
    });
  });

  app.put("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    const { content } = req.body as { content: string };
    fs.writeFileSync(filePath, content);
    res.json({ id, title: titleFromContent(content, id), content });
  });

  app.put("/api/markdown-file", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath?.toLowerCase().endsWith(".md")) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "Markdown file not found" });
      return;
    }

    const { content, expectedVersion } = req.body as {
      content: string;
      expectedVersion?: string;
    };
    const currentVersion = fileVersionFromFile(absolutePath);

    if (expectedVersion && expectedVersion !== currentVersion) {
      res.status(409).json({
        error: "Markdown file changed on disk",
        current: markdownPageFromFile(relativePath, absolutePath),
      });
      return;
    }

    let previousContent: string | null = null;
    try {
      previousContent = fs.readFileSync(absolutePath, "utf-8");
    } catch {}

    fs.writeFileSync(absolutePath, content);
    recordDocumentSave(absolutePath);
    emitCommentsAddedBySave(
      { absolutePath, projectDir, relativePath },
      previousContent,
      content,
    );
    res.json(markdownPageFromFile(relativePath, absolutePath));
  });

  app.post("/api/pages", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const { title, content: bodyContent } = req.body as {
      title?: string;
      content?: string;
    };
    const id = nextUntitledId(projectDir);
    const content = bodyContent || `# ${title || "Untitled"}\n`;
    const filePath = path.join(projectDir, `${id}.md`);
    fs.writeFileSync(filePath, content);

    res.status(201).json(markdownPageFromFile(`${id}.md`, filePath));
  });

  app.delete("/api/pages/:id", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const id = req.params.id;
    const filePath = pageFilePathFromId(projectDir, id);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    fs.unlinkSync(filePath);

    res.json({ ok: true });
  });

  function liveTabs(): OpenDocumentTab[] {
    const now = Date.now();
    const pollers = Array.from(openRequestPollers.values()).filter(
      (poller) => now - poller.lastSeenAt <= OPEN_REQUEST_POLLER_TTL_MS,
    );
    return [...openRequestClients, ...pollers];
  }

  // Oldest tab first, so the newest one is last, like open-request routing.
  function openDocuments(): OpenDocumentRecord[] {
    const documents: OpenDocumentRecord[] = [];
    for (const tab of liveTabs()) {
      if (tab.path === null) continue;
      documents.push({
        path: tab.path,
        sessionLabel: tab.sessionLabel,
        openedAt: tab.openedAt,
        lastSavedAt: tab.lastSavedAt,
      });
    }
    return documents.sort(
      (left, right) => Date.parse(left.openedAt) - Date.parse(right.openedAt),
    );
  }

  // A save that adds reviewer comments wakes the agents watching with
  // includeComments. It never fails the save itself.
  function emitCommentsAddedBySave(
    target: { absolutePath: string; projectDir: string; relativePath: string },
    previousContent: string | null,
    content: string,
  ): void {
    if (previousContent === null || typeof content !== "string") return;
    try {
      const comments = detectNewReviewerComments(previousContent, content);
      if (comments.length === 0) return;
      reviewEvents.emitComments({
        documentPath: target.absolutePath,
        projectPath: target.projectDir,
        relativePath: target.relativePath,
        version: fileVersionFromFile(target.absolutePath),
        comments,
      });
    } catch {}
  }

  function recordDocumentSave(absolutePath: string): void {
    const savedAt = new Date().toISOString();
    for (const tab of liveTabs()) {
      if (tab.path !== null && samePath(tab.path, absolutePath)) {
        tab.lastSavedAt = savedAt;
      }
    }
  }

  app.get("/api/status", (_req, res) => {
    res.json({
      backend: "local-files",
      pid: process.pid,
      port,
      projectDir: options.projectDir
        ? path.resolve(options.projectDir)
        : undefined,
      serverRoot,
      instanceId,
      stateless: true,
      documents: openDocuments(),
      capabilities: {
        projectPathRequired: true,
        fileSystemBrowsing: true,
        remoteDocuments: true,
        remoteDocumentTokenRequired: remoteDocumentToken !== null,
      },
    });
  });

  app.get("/api/open-requests", (req, res) => {
    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? req.query.path.trim()
        : null;
    const client: OpenRequestClient = {
      id: nextOpenRequestClientId,
      path: requestedPath,
      sessionLabel: normalizeSessionLabel(req.query.label),
      openedAt: new Date().toISOString(),
      lastSavedAt: null,
      response: res,
    };
    nextOpenRequestClientId += 1;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(
      `event: connected\ndata: ${JSON.stringify({ id: client.id })}\n\n`,
    );

    openRequestClients.add(client);
    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 15_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      openRequestClients.delete(client);
    });
  });

  app.get("/api/open-requests/poll", (req, res) => {
    const clientId =
      typeof req.query.clientId === "string" ? req.query.clientId.trim() : "";
    if (!clientId) {
      res.status(400).json({ error: "clientId is required" });
      return;
    }

    const now = Date.now();
    for (const [id, poller] of openRequestPollers) {
      if (now - poller.lastSeenAt > OPEN_REQUEST_POLLER_TTL_MS) {
        openRequestPollers.delete(id);
      }
    }

    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? req.query.path.trim()
        : null;
    const existing = openRequestPollers.get(clientId);
    const poller: OpenRequestPoller = existing ?? {
      path: requestedPath,
      sessionLabel: normalizeSessionLabel(req.query.label),
      openedAt: new Date(now).toISOString(),
      lastSavedAt: null,
      lastSeenAt: now,
      pending: [],
    };
    if (existing && !samePathOrBothNull(existing.path, requestedPath)) {
      // The tab now shows another document: its open time and saves restart.
      poller.openedAt = new Date(now).toISOString();
      poller.lastSavedAt = null;
    }
    poller.path = requestedPath;
    poller.sessionLabel = normalizeSessionLabel(req.query.label);
    poller.lastSeenAt = now;
    openRequestPollers.set(clientId, poller);

    const requests = poller.pending;
    poller.pending = [];
    res.json({ requests });
  });

  app.post("/api/open-request", (req, res) => {
    const payload = req.body as OpenRequestPayload;
    const targetPath =
      typeof payload.path === "string" && payload.path.trim().length > 0
        ? payload.path.trim()
        : null;
    const targetUrl =
      typeof payload.url === "string" && payload.url.trim().length > 0
        ? payload.url.trim()
        : null;

    if (!targetPath || !targetUrl) {
      res.status(400).json({ error: "path and url are required" });
      return;
    }
    const sessionLabel = normalizeSessionLabel(payload.label);
    const event = { path: targetPath, url: targetUrl, label: sessionLabel };

    const showsTarget = (candidate: string | null) =>
      candidate !== null && samePath(candidate, targetPath);

    const matchingClient = Array.from(openRequestClients)
      .reverse()
      .find((client) => showsTarget(client.path));

    if (!matchingClient) {
      const now = Date.now();
      const matchingPoller = Array.from(openRequestPollers.values())
        .filter(
          (poller) =>
            showsTarget(poller.path) &&
            now - poller.lastSeenAt <= OPEN_REQUEST_POLLER_TTL_MS,
        )
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];

      if (matchingPoller) {
        // The tab reports the label it adopts on its next poll too; set it
        // now so `status` names the new session right away.
        matchingPoller.sessionLabel = sessionLabel;
        matchingPoller.pending.push(event);
        res.json({ delivered: true });
        return;
      }

      res.json({ delivered: false });
      return;
    }

    matchingClient.sessionLabel = sessionLabel;
    matchingClient.response.write(
      `event: open-request\ndata: ${JSON.stringify(event)}\n\n`,
    );
    res.json({ delivered: true });
  });

  // Orca browser tabs ignore window.close(), so the "Close window" button
  // asks for its tab to be closed here. Only this machine may ask, and only
  // for a Roughdraft document URL.
  app.post("/api/orca/close-tab", async (req, res) => {
    const pageUrl =
      typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!isSameRoughdraftDocument(pageUrl, pageUrl)) {
      res.status(400).json({ error: "url must be a Roughdraft document URL" });
      return;
    }
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Only this computer can close its tabs" });
      return;
    }

    const result = await closeOrcaTabShowing({
      command: orca.command,
      url: pageUrl,
      run: orca.run,
    });
    res.json({ closed: result.closed });
  });

  app.post("/api/remote-document", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const payload = req.body as RemoteDocumentRegisterPayload;
    const sessionId =
      typeof payload.sessionId === "string" &&
      payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : null;
    const originPath =
      typeof payload.originPath === "string" &&
      payload.originPath.trim().length > 0
        ? payload.originPath.trim()
        : null;
    const content =
      typeof payload.content === "string" ? payload.content : null;

    if (!sessionId || !originPath || content === null) {
      res
        .status(400)
        .json({ error: "sessionId, originPath, and content are required" });
      return;
    }

    if (remoteSessions.has(sessionId)) {
      res.status(409).json({ error: "session already exists" });
      return;
    }

    const session: RemoteSession = {
      id: sessionId,
      originPath,
      content,
      version: remoteSessionVersion(content),
      saveClient: null,
      viewers: new Set<Response>(),
      disconnectedAt: null,
    };
    remoteSessions.set(sessionId, session);

    const host = req.get("host");
    const viewerUrl =
      host !== undefined
        ? `${req.protocol}://${host}/?session=${encodeURIComponent(sessionId)}`
        : null;

    res.status(201).json({
      id: session.id,
      version: session.version,
      viewerUrl,
    });
  });

  app.get("/api/remote-document/:id", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const session = remoteSessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Remote document session not found" });
      return;
    }
    res.json(remoteSessionView(session));
  });

  app.put("/api/remote-document/:id", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const session = remoteSessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Remote document session not found" });
      return;
    }

    const payload = req.body as RemoteDocumentSavePayload;
    const content =
      typeof payload.content === "string" ? payload.content : null;

    if (content === null) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    if (
      typeof payload.expectedVersion === "string" &&
      payload.expectedVersion !== session.version
    ) {
      res.status(409).json({
        error: "Remote document changed",
        current: remoteSessionView(session),
      });
      return;
    }

    session.content = content;
    session.version = remoteSessionVersion(content);

    let deliveredToClient = true;
    if (session.saveClient) {
      try {
        writeRemoteSessionEvent(session.saveClient, "save", {
          content: session.content,
          version: session.version,
        });
      } catch {
        deliveredToClient = false;
        session.saveClient = null;
        session.disconnectedAt = Date.now();
      }
    } else {
      deliveredToClient = false;
    }

    if (!deliveredToClient) {
      res.status(503).json({
        error: "No active CLI session; save not delivered to disk.",
        version: session.version,
      });
      return;
    }

    res.json({ id: session.id, version: session.version });
  });

  app.get("/api/remote-document/:id/events", (req, res) => {
    if (!isAuthorizedRemoteDocumentRequest(req)) {
      rejectUnauthorizedRemoteDocumentRequest(res);
      return;
    }
    const session = remoteSessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Remote document session not found" });
      return;
    }

    const role = req.query.role === "viewer" ? "viewer" : "cli";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (role === "cli") {
      if (session.saveClient) {
        session.saveClient.end();
      }

      session.saveClient = res;
      session.disconnectedAt = null;

      writeRemoteSessionEvent(res, "connected", {
        id: session.id,
        role,
        version: session.version,
      });
      for (const viewer of session.viewers) {
        writeRemoteSessionEvent(viewer, "connected", {
          id: session.id,
          role: "viewer",
          version: session.version,
        });
      }
    } else {
      session.viewers.add(res);
      writeRemoteSessionEvent(
        res,
        session.saveClient ? "connected" : "disconnected",
        {
          id: session.id,
          role,
          version: session.version,
        },
      );
    }

    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, REMOTE_SESSION_KEEPALIVE_MS);

    req.on("close", () => {
      clearInterval(keepAlive);
      if (role === "cli" && session.saveClient === res) {
        session.saveClient = null;
        session.disconnectedAt = Date.now();
        for (const viewer of session.viewers) {
          writeRemoteSessionEvent(viewer, "disconnected", {
            id: session.id,
            role: "viewer",
            version: session.version,
          });
        }
      } else if (role === "viewer") {
        session.viewers.delete(res);
      }
    });
  });

  app.get("/api/update-status", async (_req, res) => {
    const updateStatus = await resolveUpdateStatus({
      fetchImpl,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
    });
    res.json(updateStatus);
  });

  app.get("/api/directories", (req, res) => {
    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? path.resolve(req.query.path)
        : homeDir;

    if (!isExistingDirectory(requestedPath)) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    res.json(listDirectories(requestedPath));
  });

  app.get("/api/fs/list", (req, res) => {
    const requestedPath =
      typeof req.query.path === "string" && req.query.path.trim().length > 0
        ? path.resolve(req.query.path)
        : homeDir;

    if (!fs.existsSync(requestedPath)) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    if (!isExistingDirectory(requestedPath)) {
      res.status(400).json({ error: "Path is not a directory" });
      return;
    }

    try {
      res.json(listFileSystem(requestedPath, homeDir));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to read directory listing";
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/file-tree", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    res.json(listProjectTree(projectDir));
  });

  app.post("/api/project/open", (req, res) => {
    const requestedPath =
      typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const absolutePath = path.resolve(requestedPath);
    if (!isExistingDirectory(absolutePath)) {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    res.json({
      backend: "local-files",
      projectDir: absolutePath,
      port,
    });
  });

  app.post("/api/project/create", (req, res) => {
    const requestedPath =
      typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const absolutePath = path.resolve(requestedPath);
    ensureDirectoryExists(absolutePath);

    res.status(201).json({
      backend: "local-files",
      projectDir: absolutePath,
      port,
    });
  });

  app.get("/api/files", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const relativePath =
      typeof req.query.path === "string" ? req.query.path : "";
    const absolutePath = ensureProjectPath(projectDir, relativePath);

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    res.sendFile(absolutePath);
  });

  app.post("/api/assets", (req, res) => {
    const projectDir = projectDirFromRequest(req, res);
    if (!projectDir) return;

    const payload = req.body as AssetPayload;
    if (!payload.filename || !payload.dataBase64) {
      res.status(400).json({ error: "filename and dataBase64 are required" });
      return;
    }

    const relativePath = nextAssetPath(projectDir, payload.filename);
    const absolutePath = ensureProjectPath(projectDir, relativePath);
    if (!absolutePath) {
      res.status(400).json({ error: "Invalid asset path" });
      return;
    }

    const buffer = Buffer.from(payload.dataBase64, "base64");
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, buffer);

    res.status(201).json({
      markdownPath: `./${relativePath}`,
      previewUrl: `/api/files?projectPath=${encodeURIComponent(projectDir)}&path=${encodeURIComponent(relativePath)}`,
      mimeType: payload.mimeType || "application/octet-stream",
    });
  });

  // --- Tab windows and the batch queue ---

  function readOrcaTarget(value: unknown): OrcaTargetSnapshot | null {
    if (!value || typeof value !== "object") return null;
    const { command, worktree } = value as Record<string, unknown>;
    if (typeof command !== "string" || command.trim().length === 0) {
      return null;
    }
    return {
      command: command.trim(),
      worktree:
        typeof worktree === "string" && worktree.trim().length > 0
          ? worktree.trim()
          : null,
    };
  }

  function readTabPath(body: unknown): string | null {
    const value = (body as { path?: unknown } | null)?.path;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }

  function readWindowId(body: unknown): string | undefined {
    const value = (body as { windowId?: unknown } | null)?.windowId;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined;
  }

  app.post("/api/tab-windows/poll", (req, res) => {
    const windowId = readWindowId(req.body);
    if (!windowId) {
      res.status(400).json({ error: "windowId is required" });
      return;
    }
    const rawTabs = (req.body as { tabs?: unknown }).tabs;
    const tabs: TabState[] = Array.isArray(rawTabs)
      ? rawTabs.flatMap((tab): TabState[] => {
          const entry = tab as Partial<TabState> | null;
          return entry && typeof entry.path === "string" && entry.path
            ? [
                {
                  path: entry.path,
                  label: normalizeSessionLabel(entry.label),
                  active: entry.active === true,
                  done: entry.done === true,
                  openThreads:
                    typeof entry.openThreads === "number"
                      ? entry.openThreads
                      : 0,
                },
              ]
            : [];
        })
      : [];
    res.json(tabWindows.poll(windowId, tabs));
  });

  app.post("/api/tabs/open", async (req, res) => {
    const body = (req.body ?? {}) as {
      tabs?: unknown;
      now?: unknown;
      windowId?: unknown;
      orcaTarget?: unknown;
      open?: unknown;
    };
    const tabs = Array.isArray(body.tabs)
      ? body.tabs.flatMap((tab) => {
          const entry = tab as {
            path?: unknown;
            label?: unknown;
            since?: unknown;
          } | null;
          return entry && typeof entry.path === "string" && entry.path.trim()
            ? [
                {
                  path: entry.path.trim(),
                  label: normalizeSessionLabel(entry.label),
                  since:
                    typeof entry.since === "string" && entry.since.trim()
                      ? entry.since.trim()
                      : null,
                },
              ]
            : [];
        })
      : [];
    if (tabs.length === 0) {
      res.status(400).json({ error: "tabs needs at least one path" });
      return;
    }
    const orcaTarget = readOrcaTarget(body.orcaTarget);
    const response = tabWindows.open({
      tabs,
      now: body.now === true,
      windowId: readWindowId(body),
      orcaTarget,
    });

    // The MCP has no terminal to open a window in: it asks the server to.
    let opened: boolean | undefined;
    if (body.open === true && response.url) {
      try {
        opened = await openTabWindow({
          url: `${publicOrigin}${response.url}`,
          orcaTarget,
        });
      } catch {
        opened = false;
      }
    }
    res.json(opened === undefined ? response : { ...response, opened });
  });

  app.post("/api/tabs/focus", (req, res) => {
    const targetPath = readTabPath(req.body);
    if (!targetPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    res.json(tabWindows.focus(targetPath, readWindowId(req.body)));
  });

  app.post("/api/tabs/close", (req, res) => {
    const targetPath = readTabPath(req.body);
    if (!targetPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    res.json(tabWindows.close(targetPath, readWindowId(req.body)));
  });

  app.post("/api/tabs/release", async (req, res) => {
    const open = (req.body as { open?: unknown } | undefined)?.open === true;
    res.json(await tabWindows.release({ open }));
  });

  app.get("/api/tabs", (_req, res) => {
    res.json(tabWindows.list());
  });

  // --- Static files & SPA fallback ---

  app.use(express.static(staticDirPath));

  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(staticDirPath, "index.html"));
  });

  return { app, port, dispose: () => tabWindows.dispose() };
}

export const ROUGHDRAFT_TOKEN_ENV = "ROUGHDRAFT_TOKEN";

export async function createServer(
  port = ROUGHDRAFT_DEFAULT_PORT,
  projectDir?: string,
): Promise<void> {
  const bindHosts = resolveBindHosts();
  const remoteDocumentToken = process.env[ROUGHDRAFT_TOKEN_ENV] ?? "";

  if (hasNonLoopbackHost(bindHosts) && remoteDocumentToken.length === 0) {
    throw new Error(
      [
        `Roughdraft refuses to bind ${bindHosts.join(", ")} without a token.`,
        "Non-loopback bindings expose the remote-document endpoints, which can",
        "rewrite files on every connected CLI machine. Set ROUGHDRAFT_TOKEN to",
        "a strong secret and pass the same value to your CLI before retrying,",
        "or remove ROUGHDRAFT_BIND_HOST to keep loopback-only.",
      ].join(" "),
    );
  }

  const { app } = createApp({
    port,
    projectDir,
    remoteDocumentToken:
      remoteDocumentToken.length > 0 ? remoteDocumentToken : undefined,
    restoreTabQueue: true,
  });
  const listeningHosts: string[] = [];

  await Promise.all(
    bindHosts.map(
      (host) =>
        new Promise<void>((resolve, reject) => {
          const server = createHttpServer(app);

          server.once("error", (error: NodeJS.ErrnoException) => {
            if (
              error.code === "EAFNOSUPPORT" ||
              error.code === "EADDRNOTAVAIL"
            ) {
              resolve();
              return;
            }

            reject(error);
          });

          server.listen(port, host, () => {
            listeningHosts.push(host);
            resolve();
          });
        }),
    ),
  );

  if (listeningHosts.length === 0) {
    throw new Error(
      `Roughdraft could not bind to any host (tried: ${bindHosts.join(", ")}).`,
    );
  }

  console.log(
    `\n  Roughdraft running at http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`,
  );
  console.log("  No active project is stored on the server.\n");
}
