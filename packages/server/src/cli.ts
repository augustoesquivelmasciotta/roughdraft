import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  diffRoughdraftDocuments,
  type RfmDiagnostic,
  validateRoughdraftMarkdown,
} from "@roughdraft/rfm";
import {
  ROUGHDRAFT_BIND_HOST,
  ROUGHDRAFT_DEFAULT_PORT,
  ROUGHDRAFT_LOOPBACK_HOSTS,
  ROUGHDRAFT_PUBLIC_HOST,
} from "./network.js";
import {
  openOrcaTab,
  type RunOrcaCommand,
  resolveOrcaTarget,
  runOrcaCommand,
} from "./orca.js";
import { findAvailablePort } from "./ports.js";
import { replyToComment } from "./review-comments.js";
import {
  DEFAULT_COMMENT_BATCH_WINDOW_MS,
  type ReviewCommentAddedEvent,
  type ReviewCompletedEvent,
  type ReviewDoneReason,
} from "./review-events.js";
import {
  ReviewWatchConnectionLostError,
  waitForReviewEvents,
} from "./review-watch.js";
import { resolveUpdateStatus, type UpdateStatus } from "./update-status.js";

const AGENT_SETUP_URL = "https://roughdraft.md/setup.md";
const ROUGHDRAFT_FLAVORED_MARKDOWN_SPEC_URL =
  "https://roughdraft.md/spec/roughdraft-flavored-markdown.md";
const AGENT_SETUP_PROMPT = `Install Roughdraft for me using \`npm i -g roughdraft\`, then read ${AGENT_SETUP_URL} and set yourself up to use it.`;
const STATUS_PATH = "/api/status";
const STATUS_TIMEOUT_MS = 750;
const SERVER_WAIT_ATTEMPTS = 40;
const SERVER_WAIT_DELAY_MS = 150;
const PROCESS_WAIT_ATTEMPTS = 20;
const PROCESS_WAIT_DELAY_MS = 150;
const USAGE_ERROR = 2;
const KNOWN_COMMANDS = [
  "open",
  "start",
  "status",
  "stop",
  "watch",
  "reply",
  "tabs",
  "changes",
  "mcp",
  "doctor",
  "help",
  "agent-setup",
  "criticmarkup",
] as const;

export interface RoughdraftServerState {
  port: number;
  pid: number;
  startedAt: string;
  url: string;
}

// One tab's open document as `/api/status` reports it.
interface StatusDocument {
  path: string;
  sessionLabel: string | null;
  openedAt: string;
  lastSavedAt: string | null;
}

interface StatusPayload {
  backend?: string;
  pid?: number;
  projectDir?: string;
  serverRoot?: string;
  port?: number;
  documents?: StatusDocument[];
}

interface ReviewIndexPayload {
  items?: Array<{ id: string; kind: string; status: string | null }>;
}

// One tab holding a document, as `status <path>` reports it.
interface OpenDocumentTab {
  sessionLabel: string | null;
  openedAt: string;
}

interface OpenDocumentStatus {
  path: string;
  open: true;
  sessionLabel: string | null;
  openedAt: string;
  lastSavedAt: string | null;
  tabs: OpenDocumentTab[];
  // Null when the review index could not be read; `threadsError` says why.
  openThreads: { count: number; ids: string[] } | null;
  threadsError: string | null;
}

interface DevFrontendState {
  apiPort: number | null;
  appPort: number;
  mode?: "full-dev" | "preview-web";
  repoRoot: string;
  startedAt: string;
  url: string;
}

interface LiveDevFrontend {
  frontendUrl: string;
  apiUrl: string | null;
}

export interface SpawnedServer {
  pid: number;
}

export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetchImpl: typeof fetch;
  findAvailablePortImpl: typeof findAvailablePort;
  sleepImpl: (ms: number) => Promise<void>;
  spawnServerProcess: (options: {
    port: number;
    projectDir: string;
  }) => Promise<SpawnedServer> | SpawnedServer;
  isProcessRunning: (pid: number) => boolean;
  stopProcess: (pid: number) => Promise<void>;
  openUrl: (url: string) => OpenMode;
  /** Runs the Orca CLI; used to open documents as Orca tabs inside Orca. */
  runOrcaCommand: RunOrcaCommand;
  resolveUpdateStatus: () => Promise<UpdateStatus>;
  log: (message: string) => void;
  error: (message: string) => void;
}

type OpenMode =
  | "browser"
  | "chrome-app"
  | "disabled"
  | "existing-window"
  | "existing-orca-tab"
  | "none"
  | "orca-tab";

interface EnsureRunningResult {
  server: ReusableServer;
  reused: boolean;
  portChanged: boolean;
}

interface ResolvedTargetPath {
  projectDir: string;
  openPath: string;
}

interface ReusableServer {
  port: number;
  url: string;
  tracked: boolean;
  pid: number | null;
  startedAt: string | null;
  documents: StatusDocument[];
}

type KnownCommand = (typeof KNOWN_COMMANDS)[number];

interface ParsedGlobalFlags {
  help: boolean;
  json: boolean;
  noColor: boolean;
  version: boolean;
}

interface ParsedCli {
  command: string | null;
  global: ParsedGlobalFlags;
  rest: string[];
}

interface ParsedCommandOptions {
  all: boolean;
  batchWindowSeconds: number;
  batchWindowExplicit: boolean;
  afterSequence?: number;
  comments: boolean;
  help: boolean;
  json: boolean;
  label?: string;
  loop: boolean;
  /** Skip the batch queue: add the tab to the window at once. */
  now: boolean;
  noOpen: boolean;
  noWatch: boolean;
  printUrl: boolean;
  port?: string;
  /** What to compare against (`open`, `tabs add`, `changes`). */
  since?: string;
  /** Tab window to act in (the `tabs` subcommands). */
  window?: string;
  replay: boolean;
  stateDir?: string;
  stateFile?: string;
  timeoutSeconds?: number;
  watch: boolean;
  positionals: string[];
}

interface ParsedWatchOptions {
  batchWindowSeconds: number;
  /** The user passed --batch-window; otherwise --comments uses its own default. */
  batchWindowExplicit?: boolean;
  /** Only events after this sequence; replaces "from now". */
  afterSequence?: number;
  comments?: boolean;
  help: boolean;
  json: boolean;
  loop?: boolean;
  positionals: string[];
  replay: boolean;
  serverUrl?: string;
  stateDir?: string;
  stateFile?: string;
  timeoutSeconds?: number;
}

const currentServerRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

function readPackageVersion(): string {
  try {
    const packageJsonPath = path.join(currentServerRoot, "package.json");
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {}

  return "0.0.0";
}

function emitJson(log: (message: string) => void, value: unknown) {
  log(JSON.stringify(value, null, 2));
}

function parseGlobalArgs(args: string[]): ParsedCli {
  const global: ParsedGlobalFlags = {
    help: false,
    json: false,
    noColor: false,
    version: false,
  };
  const rest = [...args];
  const commandParts: string[] = [];

  while (rest.length > 0) {
    const arg = rest.shift();
    if (!arg) break;

    if (arg === "--") {
      commandParts.push(...rest);
      break;
    }

    if (arg === "-h" || arg === "--help") {
      global.help = true;
      continue;
    }

    if (arg === "--version") {
      global.version = true;
      continue;
    }

    if (arg === "--json") {
      global.json = true;
      continue;
    }

    if (arg === "--no-color") {
      global.noColor = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    commandParts.push(arg, ...rest);
    break;
  }

  const [command, ...commandRest] = commandParts;
  return {
    command: command ?? null,
    global,
    rest: commandRest,
  };
}

function takeFlagValue(
  args: string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }

  return { value, nextIndex: index + 1 };
}

function parseCommandOptions(
  args: string[],
  options: {
    allowAll?: boolean;
    allowOpen?: boolean;
    allowPort?: boolean;
    allowSince?: boolean;
    allowWatch?: boolean;
    allowWindow?: boolean;
  },
): ParsedCommandOptions {
  const parsed: ParsedCommandOptions = {
    all: false,
    batchWindowSeconds: 0.25,
    batchWindowExplicit: false,
    comments: false,
    help: false,
    json: false,
    loop: false,
    now: false,
    noOpen: false,
    noWatch: false,
    positionals: [],
    printUrl: false,
    replay: false,
    watch: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--all") {
      if (!options.allowAll) throw new Error(`Unknown flag: ${arg}`);
      parsed.all = true;
      continue;
    }

    if (arg === "--no-open") {
      if (!options.allowOpen) throw new Error(`Unknown flag: ${arg}`);
      parsed.noOpen = true;
      continue;
    }

    if (arg === "--print-url") {
      if (!options.allowOpen) throw new Error(`Unknown flag: ${arg}`);
      parsed.printUrl = true;
      parsed.noOpen = true;
      continue;
    }

    if (arg === "--label") {
      if (!options.allowOpen) throw new Error(`Unknown flag: ${arg}`);
      const next = takeFlagValue(args, index, arg);
      parsed.label = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--label=")) {
      if (!options.allowOpen) throw new Error(`Unknown flag: --label`);
      parsed.label = arg.slice("--label=".length);
      continue;
    }

    if (arg === "--since" || arg.startsWith("--since=")) {
      if (!options.allowSince) throw new Error(`Unknown flag: --since`);
      if (arg === "--since") {
        const next = takeFlagValue(args, index, arg);
        parsed.since = next.value;
        index = next.nextIndex;
      } else {
        parsed.since = arg.slice("--since=".length);
      }
      if (!parsed.since.trim()) throw new Error("--since requires a value.");
      continue;
    }

    if (arg === "--now") {
      if (!options.allowOpen) throw new Error(`Unknown flag: ${arg}`);
      parsed.now = true;
      continue;
    }

    if (arg === "--window" || arg.startsWith("--window=")) {
      if (!options.allowWindow) throw new Error(`Unknown flag: --window`);
      if (arg === "--window") {
        const next = takeFlagValue(args, index, arg);
        parsed.window = next.value;
        index = next.nextIndex;
      } else {
        parsed.window = arg.slice("--window=".length);
      }
      continue;
    }

    if (arg === "--watch") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      parsed.watch = true;
      continue;
    }

    if (arg === "--no-watch") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      parsed.noWatch = true;
      continue;
    }

    if (arg === "--loop") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      parsed.loop = true;
      continue;
    }

    if (arg === "--replay") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      parsed.replay = true;
      continue;
    }

    if (arg === "--comments") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      parsed.comments = true;
      continue;
    }

    if (arg === "--after" || arg.startsWith("--after=")) {
      if (!options.allowWatch) throw new Error(`Unknown flag: --after`);
      if (arg === "--after") {
        const next = takeFlagValue(args, index, arg);
        parsed.afterSequence = parseSequence(next.value);
        index = next.nextIndex;
      } else {
        parsed.afterSequence = parseSequence(arg.slice("--after=".length));
      }
      continue;
    }

    if (arg === "--timeout") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      const next = takeFlagValue(args, index, arg);
      parsed.timeoutSeconds = parsePositiveNumber(next.value, arg);
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--timeout=")) {
      if (!options.allowWatch) throw new Error(`Unknown flag: --timeout`);
      parsed.timeoutSeconds = parsePositiveNumber(
        arg.slice("--timeout=".length),
        "--timeout",
      );
      continue;
    }

    if (arg === "--batch-window") {
      if (!options.allowWatch) throw new Error(`Unknown flag: ${arg}`);
      const next = takeFlagValue(args, index, arg);
      parsed.batchWindowSeconds = parsePositiveNumber(next.value, arg);
      parsed.batchWindowExplicit = true;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--batch-window=")) {
      if (!options.allowWatch) throw new Error(`Unknown flag: --batch-window`);
      parsed.batchWindowSeconds = parsePositiveNumber(
        arg.slice("--batch-window=".length),
        "--batch-window",
      );
      parsed.batchWindowExplicit = true;
      continue;
    }

    if (arg === "--port") {
      if (!options.allowPort) throw new Error(`Unknown flag: ${arg}`);
      const next = takeFlagValue(args, index, arg);
      parsed.port = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--port=")) {
      if (!options.allowPort) throw new Error(`Unknown flag: --port`);
      parsed.port = arg.slice("--port=".length);
      continue;
    }

    if (arg === "--state-file") {
      const next = takeFlagValue(args, index, arg);
      parsed.stateFile = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--state-file=")) {
      parsed.stateFile = arg.slice("--state-file=".length);
      continue;
    }

    if (arg === "--state-dir") {
      const next = takeFlagValue(args, index, arg);
      parsed.stateDir = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--state-dir=")) {
      parsed.stateDir = arg.slice("--state-dir=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    parsed.positionals.push(arg);
  }

  return parsed;
}

function applyCliEnvOverrides(
  deps: CliDependencies,
  options: ParsedCommandOptions,
): CliDependencies {
  return {
    ...deps,
    env: {
      ...deps.env,
      ...(options.port ? { ROUGHDRAFT_PORT: options.port } : {}),
      ...(options.stateDir ? { ROUGHDRAFT_STATE_DIR: options.stateDir } : {}),
      ...(options.stateFile
        ? { ROUGHDRAFT_STATE_FILE: options.stateFile }
        : {}),
    },
  };
}

function parseWatchOptions(args: string[]): ParsedWatchOptions {
  const parsed: ParsedWatchOptions = {
    batchWindowSeconds: 0.25,
    help: false,
    json: false,
    positionals: [],
    replay: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--replay") {
      parsed.replay = true;
      continue;
    }

    if (arg === "--comments") {
      parsed.comments = true;
      continue;
    }

    if (arg === "--after" || arg.startsWith("--after=")) {
      if (arg === "--after") {
        const next = takeFlagValue(args, index, arg);
        parsed.afterSequence = parseSequence(next.value);
        index = next.nextIndex;
      } else {
        parsed.afterSequence = parseSequence(arg.slice("--after=".length));
      }
      continue;
    }

    if (arg === "--timeout") {
      const next = takeFlagValue(args, index, arg);
      parsed.timeoutSeconds = parsePositiveNumber(next.value, arg);
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--timeout=")) {
      parsed.timeoutSeconds = parsePositiveNumber(
        arg.slice("--timeout=".length),
        "--timeout",
      );
      continue;
    }

    if (arg === "--batch-window") {
      const next = takeFlagValue(args, index, arg);
      parsed.batchWindowSeconds = parsePositiveNumber(next.value, arg);
      parsed.batchWindowExplicit = true;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--batch-window=")) {
      parsed.batchWindowSeconds = parsePositiveNumber(
        arg.slice("--batch-window=".length),
        "--batch-window",
      );
      parsed.batchWindowExplicit = true;
      continue;
    }

    if (arg === "--state-file") {
      const next = takeFlagValue(args, index, arg);
      parsed.stateFile = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--state-file=")) {
      parsed.stateFile = arg.slice("--state-file=".length);
      continue;
    }

    if (arg === "--state-dir") {
      const next = takeFlagValue(args, index, arg);
      parsed.stateDir = next.value;
      index = next.nextIndex;
      continue;
    }

    if (arg.startsWith("--state-dir=")) {
      parsed.stateDir = arg.slice("--state-dir=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    parsed.positionals.push(arg);
  }

  return parsed;
}

function parseSequence(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--after must be a whole number (an event sequence).");
  }
  return parsed;
}

function parsePositiveNumber(value: string, flag: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return parsed;
}

function applyWatchEnvOverrides(
  deps: CliDependencies,
  options: ParsedWatchOptions,
): CliDependencies {
  return {
    ...deps,
    env: {
      ...deps.env,
      ...(options.stateDir ? { ROUGHDRAFT_STATE_DIR: options.stateDir } : {}),
      ...(options.stateFile
        ? { ROUGHDRAFT_STATE_FILE: options.stateFile }
        : {}),
    },
  };
}

function isKnownCommand(value: string): value is KnownCommand {
  return (KNOWN_COMMANDS as readonly string[]).includes(value);
}

function isPathLikeInput(value: string): boolean {
  return (
    value.toLowerCase().endsWith(".md") ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    current[0] = aIndex;
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      current[bIndex] = Math.min(
        previous[bIndex] + 1,
        current[bIndex - 1] + 1,
        previous[bIndex - 1] + (a[aIndex - 1] === b[bIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length] ?? 0;
}

function suggestCommand(command: string): string | null {
  const suggestion = KNOWN_COMMANDS.map((candidate) => ({
    candidate,
    distance: levenshteinDistance(command, candidate),
  })).sort((left, right) => left.distance - right.distance)[0];

  return suggestion && suggestion.distance <= 3 ? suggestion.candidate : null;
}

type SpawnSyncCommand = typeof spawnSync;
type OpenDetachedCommand = typeof openDetached;

function hasChromeAppMode(
  platform: NodeJS.Platform = process.platform,
  spawnSyncCommand: SpawnSyncCommand = spawnSync,
) {
  if (platform !== "darwin") return false;
  return (
    spawnSyncCommand("open", ["-Ra", "Google Chrome"], {
      stdio: "ignore",
    }).status === 0
  );
}

function openDetached(command: string, args: string[]) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function resolveDefaultBrowserBundleId(
  platform: NodeJS.Platform = process.platform,
  spawnSyncCommand: SpawnSyncCommand = spawnSync,
): string | null {
  if (platform !== "darwin") return null;

  const result = spawnSyncCommand(
    "plutil",
    [
      "-extract",
      "LSHandlers",
      "json",
      "-o",
      "-",
      path.join(
        os.homedir(),
        "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
      ),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  if (result.status !== 0) return null;

  try {
    const handlers = JSON.parse(result.stdout) as Array<{
      LSHandlerRoleAll?: string;
      LSHandlerURLScheme?: string;
    }>;
    return (
      handlers
        .find((handler) => handler.LSHandlerURLScheme === "http")
        ?.LSHandlerRoleAll?.trim()
        .toLowerCase() ?? null
    );
  } catch {
    return null;
  }
}

function isChromeBundleId(bundleId: string | null): boolean {
  return bundleId === "com.google.chrome";
}

export function createDefaultOpenUrl({
  env = process.env,
  platform = process.platform,
  spawnSyncCommand = spawnSync,
  openDetachedCommand = openDetached,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnSyncCommand?: SpawnSyncCommand;
  openDetachedCommand?: OpenDetachedCommand;
} = {}): (url: string) => OpenMode {
  return (url: string) => {
    if (env.ROUGHDRAFT_NO_OPEN === "1") {
      return "disabled";
    }

    if (
      isChromeBundleId(
        resolveDefaultBrowserBundleId(platform, spawnSyncCommand),
      )
    ) {
      if (hasChromeAppMode(platform, spawnSyncCommand)) {
        openDetachedCommand("open", [
          "-na",
          "Google Chrome",
          "--args",
          `--app=${url}`,
        ]);
        return "chrome-app";
      }
    }

    if (platform === "darwin") {
      openDetachedCommand("open", [url]);
      return "browser";
    }

    if (platform === "linux") {
      openDetachedCommand("xdg-open", [url]);
      return "browser";
    }

    if (platform === "win32") {
      openDetachedCommand("cmd", ["/c", "start", "", url]);
      return "browser";
    }

    return "none";
  };
}

function defaultOpenUrl(url: string): OpenMode {
  return createDefaultOpenUrl()(url);
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function defaultStopProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
    return;
  }

  for (let attempt = 0; attempt < PROCESS_WAIT_ATTEMPTS; attempt += 1) {
    if (!defaultIsProcessRunning(pid)) {
      return;
    }
    await sleep(PROCESS_WAIT_DELAY_MS);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

function defaultSpawnServerProcess(options: {
  port: number;
  projectDir: string;
}): SpawnedServer {
  const serverEntryPath = fileURLToPath(new URL("./child.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      serverEntryPath,
      "--port",
      String(options.port),
      "--project-dir",
      options.projectDir,
    ],
    {
      cwd: options.projectDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to start Roughdraft in the background.");
  }

  return { pid: child.pid };
}

export function createCliDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  const fetchImpl = overrides.fetchImpl ?? fetch;

  return {
    env: overrides.env ?? process.env,
    cwd: overrides.cwd ?? process.cwd(),
    fetchImpl,
    findAvailablePortImpl: overrides.findAvailablePortImpl ?? findAvailablePort,
    sleepImpl: overrides.sleepImpl ?? ((ms) => sleep(ms)),
    spawnServerProcess:
      overrides.spawnServerProcess ?? defaultSpawnServerProcess,
    isProcessRunning: overrides.isProcessRunning ?? defaultIsProcessRunning,
    stopProcess: overrides.stopProcess ?? defaultStopProcess,
    openUrl: overrides.openUrl ?? defaultOpenUrl,
    runOrcaCommand: overrides.runOrcaCommand ?? runOrcaCommand,
    resolveUpdateStatus:
      overrides.resolveUpdateStatus ??
      (() => resolveUpdateStatus({ fetchImpl })),
    log: overrides.log ?? ((message) => console.log(message)),
    error: overrides.error ?? ((message) => console.error(message)),
  };
}

async function printUpdateNoticeIfAvailable(deps: CliDependencies) {
  try {
    const updateStatus = await deps.resolveUpdateStatus();
    if (!updateStatus.updateAvailable) return;

    deps.log(
      `Roughdraft update available: ${updateStatus.currentVersion} -> ${updateStatus.latestVersion}. Run \`${updateStatus.updateCommand}\` to update.`,
    );
  } catch {}
}

function printHelp(log: (message: string) => void) {
  log("Roughdraft is a local Markdown review app for AI-assisted workflows.");
  log("");
  log("Usage:");
  log("  roughdraft [flags] <command> [args]");
  log("  roughdraft <path>");
  log("");
  log("Commands:");
  log("  open <path>        Open a Markdown file and wait for Done Reviewing");
  log("  start              Start or reuse the background server");
  log("  status [<path>]    Show server status, or a document's open threads");
  log("  stop               Stop the managed background server");
  log("  watch <path>...    Wait for a Done Reviewing event (or new comments)");
  log("  tabs               List the window's tabs and queue; add, focus, close, release");
  log("  changes <path>     List what changed in a document since a baseline");
  log("  reply <path>       Reply to a comment in a document");
  log("  mcp                Start the experimental stdio MCP server");
  log("  doctor [path]      Diagnose setup or validate Markdown");
  log("  help agent         Print the agent setup prompt");
  log("  help criticmarkup  Show CriticMarkup examples");
  log("  agent-setup        Print the agent setup prompt");
  log("  criticmarkup       Show CriticMarkup examples");
  log("");
  log("Flags:");
  log("  -h, --help         Show help");
  log("  --version          Print version");
  log("  --json             Print JSON for supported commands");
  log("  --no-color         Disable color");
  log("");
  log("Examples:");
  log("  roughdraft open ./draft.md");
  log("  roughdraft open ./draft.md --print-url");
  log("  roughdraft open ./draft.md --json");
  log("  roughdraft open ./draft.md --no-watch");
  log("  roughdraft open ./draft.md --loop --json");
  log("  roughdraft open ./a.md ./b.md --now");
  log("  roughdraft watch ./a.md ./b.md --json");
  log("  roughdraft tabs --json");
  log("  roughdraft watch ./draft.md --json");
  log("  roughdraft watch ./draft.md --comments --json");
  log('  roughdraft reply ./draft.md --to c1 "Done, moved it above."');
  log("  roughdraft status --json");
  log("  roughdraft status ./draft.md");
  log("");
  log(`Agent setup: ${AGENT_SETUP_URL}`);
  log("Use `roughdraft help agent` for a copyable setup prompt.");
}

function printCommandHelp(
  command: KnownCommand,
  log: (message: string) => void,
) {
  if (command === "open") {
    log("Usage:");
    log(
      "  roughdraft open <path> [<path>...] [--now] [--label <text>] [--since <x>] [--no-open] [--no-watch] [--loop] [--comments] [--print-url] [--port <port>]",
    );
    log("");
    log(
      "Opens Markdown files and waits for Done Reviewing. Starts Roughdraft if needed.",
    );
    log("");
    log(
      "Every file is a tab of one Roughdraft window. A file opened while a batch",
    );
    log(
      "is running waits in a queue and appears with the next batch (every 2 hours,",
    );
    log(
      "ROUGHDRAFT_TAB_BATCH_MINUTES changes that); the command says when and",
    );
    log(
      "keeps waiting. --now adds the tab at once. When no batch has opened in the",
    );
    log(
      "last 2 hours, the file opens at once and starts a batch. --loop, --comments",
    );
    log("and --after need a single file.");
    log("");
    log(
      "Loop mode (--loop) returns after each round like the default, and also",
    );
    log(
      "reports whether the reviewer signaled done: an overall comment that says",
    );
    log(
      'the review is done ("done", "lgtm", "looks good", "listo" and the like,',
    );
    log("as the whole comment) or a submission with every thread cleared.");
    log("Anything else means act on the feedback and reopen the document. The");
    log('--json output carries `done` and `doneReason` ("overall-comment",');
    log('"threads-cleared" or null); <name>-status.json next to the document');
    log("carries the same two fields.");
    log("");
    log("Flags:");
    log(
      "  --now                Add the tab to the window at once, skipping the queue",
    );
    log(
      "  --no-open            Start/reuse the server without opening a browser",
    );
    log(
      "  --print-url          Print only the document URL and do not open it",
    );
    log("  --no-watch           Open the file without waiting");
    log(
      "  --loop               Report whether the round ended with a done-signal",
    );
    log(
      "  --comments           Also return on each new comment or reply (see watch --comments)",
    );
    log(
      "  --after <sequence>   Only events after this sequence (the sequence of a comment line)",
    );
    log(
      "  --label <text>       Name this session; the document header shows who opened it",
    );
    log(
      "  --since <x>          Color what changed since x: last-review (default), a file, or a git ref",
    );
    log("  --timeout <seconds>  Maximum watch time; omitted means no timeout");
    log("  --replay             Allow watch to return retained older events");
    log("  --json               Print machine-readable output");
    log("  --port <port>        Preferred server port");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    log("");
    log("If the server stops while waiting (roughdraft stop, an upgrade), the");
    log(
      "wait survives a restart: the command reconnects and keeps waiting for",
    );
    log("Done Reviewing. When the server does not come back within the");
    log(
      "reconnect window (default 120 s) the command exits 1 and says so; the",
    );
    log("--json output then carries `disconnected: true`.");
    log("");
    log("Environment variables:");
    log(
      "  ROUGHDRAFT_HOST       Route open through a hosted Roughdraft instance",
    );
    log("                        (remote mode). The CLI registers a session,");
    log("                        opens an SSE channel, and writes save events");
    log("                        back to disk.");
    log(
      "  ROUGHDRAFT_TOKEN      Bearer token sent on remote-document requests.",
    );
    log("                        Required when the hosted server binds to a");
    log("                        non-loopback host. Must match the value the");
    log("                        hosted server was started with.");
    log("  ROUGHDRAFT_NO_OPEN    Set to 1 to suppress browser launch.");
    log("  ROUGHDRAFT_WATCH_RECONNECT_SECONDS");
    log("                        Seconds to wait for a stopped server to come");
    log("                        back before giving up (default: 120).");
    log("  ROUGHDRAFT_ORCA       Inside an Orca terminal, documents open as a");
    log(
      "                        tab of that worktree in Orca's browser, which",
    );
    log(
      "                        Orca mobile can also show. Set to 0 to use the",
    );
    log(
      "                        regular browser. Set to 1 to require Orca, also",
    );
    log(
      "                        from another terminal: if Orca cannot open the",
    );
    log(
      "                        tab, open exits 1 instead of using the browser.",
    );
    log("  ROUGHDRAFT_BIND_HOST  Comma-separated bind hosts for the hosted");
    log(
      "                        server (default: loopback). Set to 0.0.0.0 or",
    );
    log("                        a Tailscale interface to expose remotely.");
    log("                        Requires ROUGHDRAFT_TOKEN.");
    return;
  }

  if (command === "start") {
    log("Usage:");
    log("  roughdraft start [--port <port>] [--json]");
    log("");
    log("Starts or reuses the background Roughdraft server.");
    log("");
    log("Flags:");
    log("  --json               Print machine-readable output");
    log("  --port <port>        Preferred server port");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "status") {
    log("Usage:");
    log("  roughdraft status [<path>] [--json]");
    log("");
    log("Shows whether Roughdraft is running, and which documents are open in");
    log("it with the session label each was opened with.");
    log("");
    log("With a path, reports that document's open threads and last save: an");
    log("open thread is any comment, reply or suggestion not marked resolved,");
    log("which is the same count that ends the review loop, and the last save");
    log("is the last time this server wrote the document while a tab had it");
    log("open. A path that no tab has open is reported as not open, and a");
    log("review index that cannot be read is reported as an error at exit 1.");
    log("");
    log("When several tabs hold the same path, Session and Opened name the");
    log("newest tab and Also open in lists the rest.");
    log("");
    log("Flags:");
    log("  --json               Print machine-readable output");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "stop") {
    log("Usage:");
    log("  roughdraft stop [--all]");
    log("");
    log("Stops the managed background Roughdraft server.");
    log("");
    log("Flags:");
    log(
      "  --all                Also stop a confidently detected unmanaged server",
    );
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "watch") {
    log("Usage:");
    log(
      "  roughdraft watch <path> [<path>...] [--comments] [--json] [--timeout <seconds>]",
    );
    log("");
    log(
      "Waits until Roughdraft receives Done Reviewing for one Markdown file.",
    );
    log("");
    log(
      "With several paths it prints one line per file as each finishes (--json:",
    );
    log(
      '{path, timedOut, events}) and then {"allDone":true}. Exit 0 when every file',
    );
    log(
      "is done, 1 on a timeout. --comments and --after need a single file.",
    );
    log("");
    log(
      "With --comments it also returns when the reviewer writes new comments or",
    );
    log(
      "replies, so an agent can answer each one in its thread (roughdraft reply)",
    );
    log(
      "and watch again while the reviewer keeps reading. Comments written within",
    );
    log(
      "3 seconds come back together; --batch-window changes that. Suggestions",
    );
    log(
      "and the agent's own replies do not count. It returns on Done Reviewing too.",
    );
    log(
      "--json prints one line per comment: {type: comment.added, path, id, kind,",
    );
    log(
      "parentId, text, anchorText, author, sequence}, or the review.completed line.",
    );
    log(
      "A comment written between two watches is not lost: the server remembers",
    );
    log(
      "the last comment it handed over for the document, and the next --comments",
    );
    log(
      "watch returns the ones after it at once. --after <sequence> overrides that.",
    );
    log("Exit codes are the same as without --comments.");
    log("");
    log("Flags:");
    log("  --comments                Also return on each new comment or reply");
    log("  --json                    Print machine-readable output");
    log(
      "  --timeout <seconds>       Maximum wait time; omitted means no timeout",
    );
    log(
      "  --batch-window <seconds>  Small event batching window, default 0.25",
    );
    log(
      "  --replay                  Return retained older events if available",
    );
    log("  --state-file <path>       Server state file");
    log("  --state-dir <dir>         Directory containing server.json");
    return;
  }

  if (command === "tabs") {
    log("Usage:");
    log("  roughdraft tabs [--json]");
    log("  roughdraft tabs add <path> [--label <text>] [--since <x>] [--window <id>] [--json]");
    log("  roughdraft tabs focus <path> [--window <id>] [--json]");
    log("  roughdraft tabs close <path> [--window <id>] [--json]");
    log("  roughdraft tabs release [--json]");
    log("");
    log(
      "Roughdraft shows every document as a tab of one window. A new document",
    );
    log(
      "waits in a queue while a batch is running and joins at the next batch.",
    );
    log("");
    log("  (no action)  Lists the window's tabs and the queue with its release time");
    log("  add          Adds a tab at once, skipping the queue");
    log("  focus        Brings a tab forward");
    log("  close        Closes a tab, or drops a queued document from the queue");
    log("  release      Opens the next batch now: the queue joins the window");
    log("");
    log("Flags:");
    log("  --window <id>        Act in this window (default: the newest live one)");
    log("  --label <text>       Session label for add");
    log("  --since <x>          Baseline for add: last-review, a file, or a git ref");
    log("  --json               Print machine-readable output");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "changes") {
    log("Usage:");
    log("  roughdraft changes <path> [--since <x>] [--json]");
    log("");
    log(
      "Lists what is new, changed or removed in a document since a baseline: the",
    );
    log(
      "same comparison the page colors. Review marks and comments are not content.",
    );
    log("");
    log("Flags:");
    log(
      "  --since <x>          last-review (default: the document at the last",
    );
    log(
      "                       Done Reviewing, or at first open), a file path, or a git ref",
    );
    log(
      "  --json               Print the diff plus {source, label}",
    );
    log("");
    log("Exit 0 with the changes listed (or none), 1 when there is no baseline.");
    return;
  }

  if (command === "reply") {
    log("Usage:");
    log("  roughdraft reply <path> --to <id> [--by <name>] [--json] <text...>");
    log("");
    log(
      "Appends a reply to one comment or suggestion id in a Markdown file, the",
    );
    log("same write as the MCP roughdraft_reply_to_comment tool.");
    log("");
    log("Flags:");
    log(
      "  --to <id>            The comment or suggestion to answer (required)",
    );
    log('  --by <name>          Author of the reply, default "AI"');
    log(
      "  --json               Print {replied, id, parentId} for the new reply",
    );
    return;
  }

  if (command === "mcp") {
    log("Usage:");
    log("  roughdraft mcp");
    log("");
    log("Starts Roughdraft's experimental stdio MCP server.");
    return;
  }

  if (command === "doctor") {
    log("Usage:");
    log("  roughdraft doctor [path] [--json]");
    log("");
    log(
      "Diagnoses local Roughdraft setup and server state, or validates one Markdown file.",
    );
    log("");
    log("Flags:");
    log("  --json               Print machine-readable output");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "help") {
    printHelp(log);
    return;
  }

  if (command === "agent-setup") {
    printAgentHelp(log);
    return;
  }

  printCriticMarkupHelp(log);
}

function printAgentHelp(log: (message: string) => void) {
  log("To set up your coding agent, paste this into it:");
  log("");
  log(AGENT_SETUP_PROMPT);
  log("");
  log(`Live setup instructions: ${AGENT_SETUP_URL}`);
  log("");
  log(
    "This command only prints setup text. It does not edit agent instruction files.",
  );
}

function printCriticMarkupHelp(log: (message: string) => void) {
  log("CriticMarkup reference:");
  log("  {>>comment<<}       Comment");
  log("  {++new text++}      Insertion");
  log("  {--old text--}      Deletion");
  log("  {~~old~>new~~}      Substitution");
  log("  {==text==}          Highlight");
  log("");
  log("Examples:");
  log("  The intro {~~is vague~>needs a tighter claim~~}.");
  log("  Add {>>one concrete example here<<} before the conclusion.");
  log("");
  log("When adding new review feedback:");
  log(
    "  Prefer compact references like {>>Comment<<}{#c1} with metadata in final YAML endmatter.",
  );
  log(
    "  Use `c1`, `c2`, etc. for comment ids and `s1`, `s2`, etc. for suggested-change ids.",
  );
  log(
    "  Set `by` to your agent or author label and `at` to the current ISO timestamp.",
  );
  log(
    "  Escape a delimiter the text itself contains with a backslash, so it stays literal: {>>Write \\{>>a note\\<<} to reply.<<}.",
  );
  log("");
  log("Anchored comment with id:");
  log("  Review {==this sentence==}{>>Needs a source<<}{#c1}.");
  log("  ---");
  log("  comments:");
  log("    c1:");
  log("      by: AI");
  log('      at: "2026-04-28T12:00:00.000Z"');
  log("");
  log("Suggested changes with ids:");
  log("  Add {++one concrete example++}{#s1}.");
  log("  Replace {~~vague phrasing~>specific wording~~}{#s2}.");
  log("  ---");
  log("  suggestions:");
  log("    s1:");
  log("      by: AI");
  log('      at: "2026-04-28T12:10:00.000Z"');
  log("    s2:");
  log("      by: AI");
  log('      at: "2026-04-28T12:11:00.000Z"');
  log("");
  log("Reply to an existing comment:");
  log("  Store replies in `comments.<id>.body` with `re: <parent-id>`.");
  log("");
  log("Reply guidance:");
  log(
    "  Existing inline attribute metadata is still accepted for compatibility.",
  );
  log(
    "  Comment ids are document-local and usually look like `c1`, `c2`, `c3`.",
  );
  log("");
  log("Code blocks:");
  log(
    "  Treat CriticMarkup inside fenced code blocks as literal example text.",
  );
  log("");
  log("Full spec:");
  log(`  ${ROUGHDRAFT_FLAVORED_MARKDOWN_SPEC_URL}`);
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : ROUGHDRAFT_DEFAULT_PORT;
}

function getPreferredPort(env: NodeJS.ProcessEnv): number {
  return parsePort(env.ROUGHDRAFT_PORT || env.PORT);
}

function buildPublicBaseUrl(port: number): string {
  return `http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`;
}

function getDevFrontendStateFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitFile = env.ROUGHDRAFT_DEV_FRONTEND_STATE_FILE?.trim();
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  return path.join(currentServerRoot, ".context", "dev-frontend.json");
}

function buildLoopbackUrl(host: string, port: number, pathname = "/"): URL {
  const baseHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${baseHost}:${port}${pathname}`);
}

function buildTargetUrl(
  baseUrl: string,
  openPath: string,
  sessionLabel: string | null = null,
  since: string | null = null,
): string {
  const url = new URL(baseUrl);

  url.pathname = "/";
  url.searchParams.set("path", openPath);
  if (sessionLabel) url.searchParams.set("label", sessionLabel);
  if (since) url.searchParams.set("since", since);
  return url.toString();
}

interface SseEvent {
  event: string;
  data: string;
}

interface ParsedSseChunk {
  events: SseEvent[];
  remainder: string;
}

function parseSseEvents(buffer: string): ParsedSseChunk {
  // Normalize CRLF to LF up front so the rest of the parser can treat \n
  // as the only line terminator. SSE allows \r\n; some proxies rewrite it.
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: SseEvent[] = [];
  let cursor = 0;
  while (true) {
    const blank = normalized.indexOf("\n\n", cursor);
    if (blank === -1) break;
    const block = normalized.slice(cursor, blank);
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      }
    }
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join("\n") });
    }
    cursor = blank + 2;
  }
  return { events, remainder: normalized.slice(cursor) };
}

async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, content);
  await fs.promises.rename(tmpPath, targetPath);
}

function appendTokenToViewerUrl(viewerUrl: string, token: string): string {
  if (token.length === 0) return viewerUrl;
  try {
    const parsed = new URL(viewerUrl);
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    // Fall back to a simple suffix if the URL is malformed; the browser will
    // reject it the same way it would have without the token.
    const separator = viewerUrl.includes("?") ? "&" : "?";
    return `${viewerUrl}${separator}token=${encodeURIComponent(token)}`;
  }
}

interface RemoteOpenOptions {
  host: string;
  openPath: string;
  noOpen: boolean;
  printUrl: boolean;
  json: boolean;
}

async function runRemoteOpen(
  deps: CliDependencies,
  options: RemoteOpenOptions,
): Promise<number> {
  const baseUrl = options.host.replace(/\/$/, "");
  const remoteToken =
    typeof deps.env.ROUGHDRAFT_TOKEN === "string"
      ? deps.env.ROUGHDRAFT_TOKEN.trim()
      : "";
  const authHeaders: Record<string, string> =
    remoteToken.length > 0 ? { Authorization: `Bearer ${remoteToken}` } : {};

  let content: string;
  try {
    content = await fs.promises.readFile(options.openPath, "utf-8");
  } catch (error) {
    deps.error(
      error instanceof Error
        ? error.message
        : `Could not read ${options.openPath}`,
    );
    return 1;
  }

  const sessionId = crypto.randomUUID();

  const REGISTER_TIMEOUT_MS = 10_000;
  let registerResponse: Response;
  try {
    registerResponse = await deps.fetchImpl(`${baseUrl}/api/remote-document`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        sessionId,
        originPath: options.openPath,
        content,
      }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
  } catch (error) {
    deps.error(
      `Could not register remote session at ${baseUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  if (!registerResponse.ok) {
    if (registerResponse.status === 401) {
      deps.error(
        `Remote host rejected the session register (HTTP 401). Set ROUGHDRAFT_TOKEN to the token configured on the host before retrying.`,
      );
    } else {
      deps.error(
        `Remote host rejected the session register (HTTP ${registerResponse.status}).`,
      );
    }
    return 1;
  }

  const registerPayload = (await registerResponse.json()) as {
    id?: string;
    version?: string;
    viewerUrl?: string;
  };

  // The browser viewer must include the same token so its fetches and
  // EventSource connection authenticate. The server's viewerUrl response field
  // is unaware of the token (it doesn't see secrets in plaintext over the wire
  // unless we add them); the CLI knows the token and can append it.
  const baseViewer =
    typeof registerPayload.viewerUrl === "string"
      ? registerPayload.viewerUrl
      : `${baseUrl}/?session=${encodeURIComponent(sessionId)}`;
  const viewerUrl = appendTokenToViewerUrl(baseViewer, remoteToken);

  if (options.printUrl) {
    deps.log(viewerUrl);
    return 0;
  }

  if (!options.noOpen && deps.env.ROUGHDRAFT_NO_OPEN !== "1") {
    try {
      if (!(await openInOrcaTab(deps, viewerUrl))) {
        deps.openUrl(viewerUrl);
      }
    } catch (error) {
      if (!(error instanceof OrcaTabRequiredError)) throw error;
      deps.error(error.message);
      return 1;
    }
  }

  if (options.json) {
    emitJson(deps.log, {
      opened: true,
      mode: "remote",
      sessionId,
      url: viewerUrl,
      host: baseUrl,
      path: options.openPath,
    });
  } else {
    deps.log(`Opened remote Roughdraft session: ${viewerUrl}`);
    deps.log(`Holding session open for ${options.openPath}. Ctrl-C to exit.`);
  }

  const SSE_CONNECT_TIMEOUT_MS = 10_000;
  const eventsUrl = new URL(
    `/api/remote-document/${encodeURIComponent(sessionId)}/events`,
    baseUrl,
  );
  eventsUrl.searchParams.set("role", "cli");

  let eventsResponse: Response;
  try {
    eventsResponse = await deps.fetchImpl(eventsUrl.toString(), {
      headers: { Accept: "text/event-stream", ...authHeaders },
      signal: AbortSignal.timeout(SSE_CONNECT_TIMEOUT_MS),
    });
  } catch (error) {
    deps.error(
      `Lost connection to remote host: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  if (!eventsResponse.ok || !eventsResponse.body) {
    deps.error(
      `Could not open remote event stream (HTTP ${eventsResponse.status}).`,
    );
    return 1;
  }

  const reader = eventsResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) {
        if (event.event === "save") {
          let payload: { content?: unknown } = {};
          try {
            payload = JSON.parse(event.data) as { content?: unknown };
          } catch {
            continue;
          }
          if (typeof payload.content === "string") {
            try {
              await atomicWriteFile(options.openPath, payload.content);
              if (!options.json) {
                deps.log(`Saved ${options.openPath} from remote.`);
              }
            } catch (error) {
              deps.error(
                `Failed to write ${options.openPath}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be in an errored state; ignore.
    }
  }

  if (!options.json) {
    deps.log("Remote session disconnected.");
  }
  return 0;
}

/** `ROUGHDRAFT_ORCA=1` asked for an Orca tab and Orca could not open one. */
class OrcaTabRequiredError extends Error {}

/**
 * Inside an Orca terminal, shows the document in an Orca browser tab of the
 * terminal's worktree. Returns null when the regular browser should be used,
 * either because this is not Orca or because Orca could not open the tab.
 * With `ROUGHDRAFT_ORCA=1` a failure throws instead, so scripts that must not
 * land in the default browser can fall back on their own.
 */
async function openInOrcaTab(
  deps: CliDependencies,
  url: string,
): Promise<OpenMode | null> {
  const target = resolveOrcaTarget(deps.env);
  if (!target) return null;

  const result = await openOrcaTab({
    target,
    url,
    run: deps.runOrcaCommand,
  });
  if (result.opened) {
    return result.reused ? "existing-orca-tab" : "orca-tab";
  }

  const message = `Could not open an Orca tab (${result.reason}).`;
  if (deps.env.ROUGHDRAFT_ORCA?.trim() === "1") {
    throw new OrcaTabRequiredError(message);
  }
  deps.error(`${message} Opening the browser instead.`);
  return null;
}

// A second `open` of a document that a tab already shows reuses that tab
// (each document has its own tab, so a tab is never pointed at another
// document). When the tab belongs to another session, say so before taking
// it over: that session's reviewer is in the middle of it, and Done
// Reviewing there now reaches both sessions.
function warnBeforeReusingAnotherSessionsTab(
  deps: CliDependencies,
  documents: StatusDocument[],
  openPath: string,
  sessionLabel: string | null,
) {
  const wanted = openPath.normalize("NFC");
  const tabs = documents.filter(
    (entry) => path.resolve(entry.path).normalize("NFC") === wanted,
  );
  const owner = tabs.at(-1);
  // Same label (or neither labeled): the same session reopening for its
  // next round, which is the normal review loop.
  if (!owner || owner.sessionLabel === sessionLabel) return;

  const ownerName = owner.sessionLabel ?? "a session with no label";
  deps.error(
    `${openPath} is already open in a tab opened by ${ownerName}. This open reuses that tab; Done Reviewing there reaches every session waiting on the file.`,
  );
}

function describeOpenedDocument(openMode: OpenMode, url: string): string {
  switch (openMode) {
    case "chrome-app":
      return `Opened Roughdraft in a Chrome app window: ${url}`;
    case "existing-window":
      return `Reused an existing Roughdraft window: ${url}`;
    case "browser":
      return `Opened Roughdraft in the default browser: ${url}`;
    case "orca-tab":
      return `Opened Roughdraft in an Orca tab: ${url}`;
    case "existing-orca-tab":
      return `Reused the Roughdraft tab in Orca: ${url}`;
    default:
      return `Roughdraft is running at ${url}`;
  }
}

async function sendOpenRequestToExistingWindow(
  deps: CliDependencies,
  baseUrl: string,
  targetUrl: string,
  openPath: string,
  sessionLabel: string | null,
): Promise<boolean> {
  try {
    const requestUrl = new URL("/api/open-request", baseUrl);
    const response = await deps.fetchImpl(requestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: openPath,
        url: targetUrl,
        ...(sessionLabel ? { label: sessionLabel } : {}),
      }),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });

    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as { delivered?: unknown };
    return payload.delivered === true;
  } catch {
    return false;
  }
}

function resolveTargetPath(inputPath: string): ResolvedTargetPath {
  const resolvedPath = path.resolve(inputPath);
  const looksLikeMarkdownFile = resolvedPath.toLowerCase().endsWith(".md");

  try {
    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      throw new Error(`Roughdraft can only open .md files: ${resolvedPath}`);
    }

    if (stat.isFile()) {
      if (!looksLikeMarkdownFile) {
        throw new Error(`Roughdraft can only open .md files: ${resolvedPath}`);
      }

      return {
        projectDir: path.dirname(resolvedPath),
        openPath: resolvedPath,
      };
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Roughdraft can only open")
    ) {
      throw error;
    }

    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      throw new Error(`Path not found: ${resolvedPath}`);
    }

    throw new Error(`Failed to read path: ${resolvedPath}`);
  }

  throw new Error(`Unsupported path: ${resolvedPath}`);
}

export function getServerStateFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitFile = env.ROUGHDRAFT_STATE_FILE?.trim();
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  const explicitDir = env.ROUGHDRAFT_STATE_DIR?.trim();
  if (explicitDir) {
    return path.join(path.resolve(explicitDir), "server.json");
  }

  return path.join(os.homedir(), ".roughdraft", "server.json");
}

function isValidServerState(value: unknown): value is RoughdraftServerState {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<RoughdraftServerState>;
  return (
    typeof candidate.port === "number" &&
    Number.isFinite(candidate.port) &&
    typeof candidate.pid === "number" &&
    Number.isFinite(candidate.pid) &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0
  );
}

function isValidDevFrontendState(value: unknown): value is DevFrontendState {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<DevFrontendState>;
  return (
    (candidate.apiPort === null ||
      (typeof candidate.apiPort === "number" &&
        Number.isFinite(candidate.apiPort))) &&
    typeof candidate.appPort === "number" &&
    Number.isFinite(candidate.appPort) &&
    (candidate.mode === undefined ||
      candidate.mode === "full-dev" ||
      candidate.mode === "preview-web") &&
    typeof candidate.repoRoot === "string" &&
    candidate.repoRoot.length > 0 &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0
  );
}

function readServerStateFromDisk(
  stateFilePath: string,
): RoughdraftServerState | null {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidServerState(parsed)) {
      return parsed;
    }
  } catch {}

  if (fs.existsSync(stateFilePath)) {
    removeServerStateFile(stateFilePath);
  }

  return null;
}

function readDevFrontendStateFromDisk(
  stateFilePath: string,
): DevFrontendState | null {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidDevFrontendState(parsed)) {
      return parsed;
    }
  } catch {}

  return null;
}

function writeServerStateToDisk(
  stateFilePath: string,
  state: RoughdraftServerState,
) {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
}

function removeServerStateFile(stateFilePath: string) {
  try {
    fs.rmSync(stateFilePath, { force: true });
  } catch {}
}

async function getStatusPayload(
  port: number,
  deps: CliDependencies,
): Promise<StatusPayload | null> {
  for (const host of [ROUGHDRAFT_BIND_HOST, ...ROUGHDRAFT_LOOPBACK_HOSTS]) {
    try {
      const response = await deps.fetchImpl(
        buildLoopbackUrl(host, port, STATUS_PATH),
        {
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as StatusPayload;
      if (payload.backend === "local-files") {
        return payload;
      }
    } catch {}
  }

  return null;
}

async function waitForServer(port: number, deps: CliDependencies) {
  for (let attempt = 0; attempt < SERVER_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await getStatusPayload(port, deps);
    if (payload) {
      return payload;
    }
    await deps.sleepImpl(SERVER_WAIT_DELAY_MS);
  }

  throw new Error("Timed out waiting for Roughdraft to start.");
}

async function waitForServerToStop(
  port: number,
  deps: CliDependencies,
): Promise<boolean> {
  for (let attempt = 0; attempt < PROCESS_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await getStatusPayload(port, deps);
    if (!payload) {
      return true;
    }

    await deps.sleepImpl(PROCESS_WAIT_DELAY_MS);
  }

  return false;
}

async function resolveLiveDevFrontendBaseUrl(
  deps: CliDependencies,
): Promise<LiveDevFrontend | null> {
  const state = readDevFrontendStateFromDisk(
    getDevFrontendStateFilePath(deps.env),
  );
  if (!state) {
    return null;
  }

  if (path.resolve(state.repoRoot) !== currentServerRoot) {
    return null;
  }

  try {
    const frontendUrl = new URL(state.url);
    const mode =
      state.mode ?? (state.apiPort === null ? "preview-web" : "full-dev");

    if (mode === "preview-web") {
      const response = await deps.fetchImpl(frontendUrl, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }
    } else {
      const statusUrl = new URL("/api/status", frontendUrl);
      const response = await deps.fetchImpl(statusUrl, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as StatusPayload;
      if (payload.backend !== "local-files") {
        return null;
      }

      if (
        !payload.serverRoot ||
        path.resolve(payload.serverRoot) !== currentServerRoot
      ) {
        return null;
      }

      if (
        typeof payload.port === "number" &&
        state.apiPort !== null &&
        payload.port !== state.apiPort
      ) {
        return null;
      }
    }

    frontendUrl.pathname = "/";
    frontendUrl.search = "";
    frontendUrl.hash = "";
    return {
      frontendUrl: frontendUrl.toString(),
      apiUrl:
        mode === "full-dev" && state.apiPort !== null
          ? buildPublicBaseUrl(state.apiPort)
          : null,
    };
  } catch {
    return null;
  }
}

async function normalizeTrackedState(
  persistedState: RoughdraftServerState,
  stateFilePath: string,
): Promise<RoughdraftServerState> {
  const normalizedState = {
    ...persistedState,
    url: buildPublicBaseUrl(persistedState.port),
  };

  if (normalizedState.url !== persistedState.url) {
    writeServerStateToDisk(stateFilePath, normalizedState);
  }

  return normalizedState;
}

async function findReusableServer(
  deps: CliDependencies,
  options: { serverRoot?: string } = {},
): Promise<ReusableServer | null> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);
  const preferredPort = getPreferredPort(deps.env);
  const expectedServerRoot = path.resolve(
    options.serverRoot ?? currentServerRoot,
  );

  const matchesServerRoot = (payload: StatusPayload | null) =>
    payload?.serverRoot
      ? path.resolve(payload.serverRoot) === expectedServerRoot
      : false;

  if (persistedState) {
    const pidRunning = deps.isProcessRunning(persistedState.pid);
    const statusPayload = await getStatusPayload(persistedState.port, deps);

    if (pidRunning && statusPayload && matchesServerRoot(statusPayload)) {
      const normalizedState = await normalizeTrackedState(
        persistedState,
        stateFilePath,
      );
      return {
        port: normalizedState.port,
        url: normalizedState.url,
        tracked: true,
        pid: normalizedState.pid,
        startedAt: normalizedState.startedAt,
        documents: statusPayload.documents ?? [],
      };
    }

    removeServerStateFile(stateFilePath);

    if (statusPayload && matchesServerRoot(statusPayload)) {
      return {
        port: persistedState.port,
        url: buildPublicBaseUrl(persistedState.port),
        tracked: false,
        pid: null,
        startedAt: null,
        documents: statusPayload.documents ?? [],
      };
    }
  }

  const preferredStatus = await getStatusPayload(preferredPort, deps);
  if (!preferredStatus || !matchesServerRoot(preferredStatus)) {
    return null;
  }

  return {
    port: preferredPort,
    url: buildPublicBaseUrl(preferredPort),
    tracked: false,
    pid: null,
    startedAt: null,
    documents: preferredStatus.documents ?? [],
  };
}

export async function readRunningServerState(
  deps: CliDependencies,
): Promise<RoughdraftServerState | null> {
  const reusableServer = await findReusableServer(deps, {
    serverRoot: currentServerRoot,
  });
  if (
    !reusableServer?.tracked ||
    reusableServer.pid === null ||
    reusableServer.startedAt === null
  ) {
    return null;
  }

  return {
    port: reusableServer.port,
    pid: reusableServer.pid,
    startedAt: reusableServer.startedAt,
    url: reusableServer.url,
  };
}

export async function ensureServerRunning(
  deps: CliDependencies,
  options: { projectDir?: string } = {},
): Promise<EnsureRunningResult> {
  const reusableServer = await findReusableServer(deps, {
    serverRoot: currentServerRoot,
  });
  if (reusableServer) {
    return { server: reusableServer, reused: true, portChanged: false };
  }

  const preferredPort = getPreferredPort(deps.env);
  const port = await deps.findAvailablePortImpl(preferredPort);
  const projectDir = path.resolve(options.projectDir ?? deps.cwd);
  const spawned = await deps.spawnServerProcess({
    port,
    projectDir,
  });

  try {
    await waitForServer(port, deps);
  } catch (error) {
    await deps.stopProcess(spawned.pid);
    throw error;
  }

  const state: RoughdraftServerState = {
    port,
    pid: spawned.pid,
    startedAt: new Date().toISOString(),
    url: buildPublicBaseUrl(port),
  };
  writeServerStateToDisk(getServerStateFilePath(deps.env), state);

  return {
    server: {
      port: state.port,
      url: state.url,
      tracked: true,
      pid: state.pid,
      startedAt: state.startedAt,
      documents: [],
    },
    reused: false,
    portChanged: port !== preferredPort,
  };
}

function buildServerStatusJson(
  server: ReusableServer | null,
  stateFilePath: string,
) {
  if (!server) {
    return {
      running: false,
      stateFile: stateFilePath,
    };
  }

  return {
    running: true,
    url: server.url,
    port: server.port,
    pid: server.pid,
    startedAt: server.startedAt,
    stateFile: stateFilePath,
    managed: server.tracked,
  };
}

// Describes one open document for `status <path>`: null when no tab has it
// open. Several tabs can hold the same path; the newest one names the session
// and the latest save across them counts, and every tab is listed in `tabs`.
async function describeOpenDocument(
  server: ReusableServer,
  documentPath: string,
  deps: CliDependencies,
): Promise<OpenDocumentStatus | null> {
  const wanted = documentPath.normalize("NFC");
  const entries = server.documents.filter(
    (entry) => path.resolve(entry.path).normalize("NFC") === wanted,
  );
  const newest = entries[entries.length - 1];
  if (!newest) return null;

  const lastSavedAt = entries
    .map((entry) => entry.lastSavedAt)
    .filter((value): value is string => value !== null)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .pop();

  const openDocument = {
    path: documentPath,
    open: true as const,
    sessionLabel: newest.sessionLabel,
    openedAt: newest.openedAt,
    lastSavedAt: lastSavedAt ?? null,
    tabs: entries.map((entry) => ({
      sessionLabel: entry.sessionLabel,
      openedAt: entry.openedAt,
    })),
  };

  let reviewIndex: ReviewIndexPayload;
  try {
    const reviewIndexUrl = new URL("/api/review-index", server.url);
    reviewIndexUrl.searchParams.set("projectPath", path.dirname(documentPath));
    reviewIndexUrl.searchParams.set("path", path.basename(documentPath));
    const response = await deps.fetchImpl(reviewIndexUrl, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS * 4),
    });
    if (!response.ok) {
      throw new Error(`the server answered ${response.status}`);
    }
    reviewIndex = (await response.json()) as ReviewIndexPayload;
  } catch (error) {
    // The file can be renamed or deleted, and the server can go away, between
    // the status poll and this call. Report that instead of crashing.
    return {
      ...openDocument,
      openThreads: null,
      threadsError: error instanceof Error ? error.message : String(error),
    };
  }

  // An open thread is any item the review index leaves unresolved, replies
  // included: the same rule as `summary.unresolved`, which the
  // `threads-cleared` done-signal reads, so this count and the end of the
  // review loop always agree.
  const openThreadIds = (reviewIndex.items ?? [])
    .filter((item) => item.status !== "resolved")
    .map((item) => item.id);

  return {
    ...openDocument,
    openThreads: { count: openThreadIds.length, ids: openThreadIds },
    threadsError: null,
  };
}

function formatSessionLine(sessionLabel: string | null): string {
  return `Session: ${sessionLabel ?? "no label given"}`;
}

function printServerProcessLines(
  deps: CliDependencies,
  server: ReusableServer,
  stateFilePath: string,
) {
  if (server.tracked && server.pid !== null && server.startedAt !== null) {
    deps.log(`PID: ${server.pid}`);
    deps.log(`Started: ${server.startedAt}`);
    deps.log(`State file: ${stateFilePath}`);
    return;
  }

  deps.log(`This server is not managed by ${stateFilePath}.`);
}

async function stopTrackedServer(deps: CliDependencies): Promise<{
  persistedState: RoughdraftServerState | null;
  stopped: boolean;
  portIsQuiet: boolean;
  failedPid: number | null;
}> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);

  if (!persistedState) {
    return {
      failedPid: null,
      persistedState: null,
      portIsQuiet: true,
      stopped: false,
    };
  }

  if (deps.isProcessRunning(persistedState.pid)) {
    await deps.stopProcess(persistedState.pid);
  }

  const trackedPidStillRunning = deps.isProcessRunning(persistedState.pid);
  const portIsQuiet = await waitForServerToStop(persistedState.port, deps);

  if (trackedPidStillRunning) {
    writeServerStateToDisk(stateFilePath, {
      ...persistedState,
      url: buildPublicBaseUrl(persistedState.port),
    });
    return {
      failedPid: persistedState.pid,
      persistedState,
      portIsQuiet,
      stopped: false,
    };
  }

  removeServerStateFile(stateFilePath);
  return {
    failedPid: null,
    persistedState,
    portIsQuiet,
    stopped: true,
  };
}

async function runDoctor(
  deps: CliDependencies,
  json: boolean,
): Promise<number> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);
  const preferredPort = getPreferredPort(deps.env);
  const preferredStatus = await getStatusPayload(preferredPort, deps);
  const trackedStatus = persistedState
    ? await getStatusPayload(persistedState.port, deps)
    : null;
  const cwdReadable = (() => {
    try {
      fs.accessSync(deps.cwd, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  })();
  const managedPidRunning = persistedState
    ? deps.isProcessRunning(persistedState.pid)
    : false;
  const serverRootMatches =
    trackedStatus?.serverRoot !== undefined
      ? path.resolve(trackedStatus.serverRoot) === currentServerRoot
      : false;
  const commandPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  const devStateDir = deps.env.ROUGHDRAFT_STATE_DIR?.includes(
    `${path.sep}.roughdraft${path.sep}dev${path.sep}`,
  )
    ? path.resolve(deps.env.ROUGHDRAFT_STATE_DIR)
    : null;
  const devWrapperName = deps.env.ROUGHDRAFT_DEV_WRAPPER_NAME?.trim() || null;
  const devWrapperPath = deps.env.ROUGHDRAFT_DEV_WRAPPER_PATH?.trim()
    ? path.resolve(deps.env.ROUGHDRAFT_DEV_WRAPPER_PATH)
    : null;
  const devWrapperRepoRoot =
    deps.env.ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT?.trim() || null;

  const report = {
    packageVersion: readPackageVersion(),
    nodeVersion: process.version,
    commandPath,
    stateFile: stateFilePath,
    stateFileExists: fs.existsSync(stateFilePath),
    managedPid: persistedState?.pid ?? null,
    managedPidRunning,
    recordedPort: persistedState?.port ?? null,
    recordedPortResponds: Boolean(trackedStatus),
    preferredPort,
    preferredPortResponds: Boolean(preferredStatus),
    serverRoot: trackedStatus?.serverRoot ?? null,
    serverRootMatches,
    browserOpeningDisabled: deps.env.ROUGHDRAFT_NO_OPEN === "1",
    orcaTabs: resolveOrcaTarget(deps.env),
    cwd: deps.cwd,
    cwdReadable,
    devWrapper:
      devStateDir || devWrapperName || devWrapperPath || devWrapperRepoRoot
        ? {
            commandName: devWrapperName,
            path: devWrapperPath,
            repoRoot: devWrapperRepoRoot,
            repoRootMatches: devWrapperRepoRoot
              ? path.resolve(devWrapperRepoRoot) === currentServerRoot
              : null,
            stateDir: devStateDir,
          }
        : null,
  };

  if (json) {
    emitJson(deps.log, report);
    return 0;
  }

  deps.log(`Package version: ${report.packageVersion}`);
  deps.log(`Node version: ${report.nodeVersion}`);
  deps.log(`Command path: ${report.commandPath ?? "unknown"}`);
  deps.log(`State file: ${report.stateFile}`);
  deps.log(`State file exists: ${report.stateFileExists ? "yes" : "no"}`);
  deps.log(
    `Managed PID: ${
      report.managedPid === null
        ? "none"
        : `${report.managedPid} (${report.managedPidRunning ? "running" : "not running"})`
    }`,
  );
  deps.log(
    `Recorded port: ${
      report.recordedPort === null
        ? "none"
        : `${report.recordedPort} (${report.recordedPortResponds ? "responding" : "not responding"})`
    }`,
  );
  deps.log(
    `Preferred port: ${report.preferredPort} (${report.preferredPortResponds ? "responding" : "not responding"})`,
  );
  deps.log(
    `Server root matches checkout: ${report.serverRootMatches ? "yes" : "no"}`,
  );
  deps.log(
    `Browser opening disabled: ${report.browserOpeningDisabled ? "yes" : "no"}`,
  );
  deps.log(
    `Opens documents in Orca tabs: ${
      report.orcaTabs
        ? `yes (${report.orcaTabs.worktree ?? "worktree of the current directory"})`
        : "no"
    }`,
  );
  deps.log(`Current directory readable: ${report.cwdReadable ? "yes" : "no"}`);
  if (report.devWrapper) {
    deps.log(
      `Dev wrapper command: ${report.devWrapper.commandName ?? "unknown"}`,
    );
    deps.log(`Dev wrapper path: ${report.devWrapper.path ?? "unknown"}`);
    deps.log(
      `Dev wrapper repo root: ${report.devWrapper.repoRoot ?? "unknown"}`,
    );
    deps.log(`Dev state dir: ${report.devWrapper.stateDir ?? "unknown"}`);
  }

  return 0;
}

async function runMarkdownDoctor(
  deps: CliDependencies,
  targetPath: string,
  json: boolean,
): Promise<number> {
  if (!isMarkdownPath(targetPath)) {
    deps.error(`Roughdraft doctor can only validate .md files: ${targetPath}`);
    return USAGE_ERROR;
  }

  const absolutePath = path.resolve(deps.cwd, targetPath);
  let markdown: string;

  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      deps.error(`Path is not a file: ${absolutePath}`);
      return USAGE_ERROR;
    }
    markdown = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
    deps.error(
      code === "ENOENT"
        ? `Path not found: ${absolutePath}`
        : `Could not read path: ${absolutePath}`,
    );
    return USAGE_ERROR;
  }

  const validation = validateRoughdraftMarkdown(markdown);
  const payload = {
    kind: "markdown" as const,
    path: absolutePath,
    format: validation.format,
    version: validation.version,
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    summary: validation.summary,
  };

  if (json) {
    emitJson(deps.log, payload);
    return validation.ok ? 0 : 1;
  }

  const displayPath = relativeDisplayPath(deps.cwd, absolutePath);
  deps.log(`Roughdraft Markdown doctor: ${displayPath}`);
  deps.log(`Status: ${validation.ok ? "passed" : "failed"}`);

  if (validation.errors.length > 0) {
    deps.log("");
    deps.log("Errors:");
    for (const diagnostic of validation.errors) {
      deps.log(formatMarkdownDiagnostic(diagnostic));
    }
  }

  if (validation.warnings.length > 0) {
    deps.log("");
    deps.log("Warnings:");
    for (const diagnostic of validation.warnings) {
      deps.log(formatMarkdownDiagnostic(diagnostic));
    }
  }

  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    deps.log("");
    deps.log(
      `Found ${validation.summary.comments} comment(s) and ${validation.summary.suggestions} suggestion(s).`,
    );
  }

  return validation.ok ? 0 : 1;
}

async function runWatch(
  deps: CliDependencies,
  targetPath: string,
  options: ParsedWatchOptions,
  json: boolean,
): Promise<number> {
  const target = resolveTargetPath(targetPath);
  let serverUrl = options.serverUrl;
  if (!serverUrl) {
    const result = await ensureServerRunning(deps, {
      projectDir: target.projectDir,
    });
    serverUrl = result.server.url;
  }
  const relativePath = path.relative(target.projectDir, target.openPath);
  const reconnectSeconds = readReconnectWindowSeconds(deps.env);
  // Bounded polls: a single request would die after five minutes
  // (UND_ERR_HEADERS_TIMEOUT), and reviews can take much longer.
  let payload: Awaited<ReturnType<typeof waitForReviewEvents>>;
  try {
    payload = await waitForReviewEvents({
      fetchImpl: deps.fetchImpl,
      serverUrl,
      target: {
        projectPath: target.projectDir,
        path: relativePath,
        batchWindowSeconds:
          options.comments && !options.batchWindowExplicit
            ? DEFAULT_COMMENT_BATCH_WINDOW_MS / 1000
            : options.batchWindowSeconds,
        ...(options.comments ? { includeComments: true } : {}),
      },
      timeoutSeconds: options.timeoutSeconds,
      fromNow: !options.replay && options.afterSequence === undefined,
      afterSequence: options.afterSequence,
      failureWindowMs: reconnectSeconds * 1000,
      onConnectionLost: () => {
        deps.error(
          `Roughdraft server at ${serverUrl} stopped during the review; waiting up to ${reconnectSeconds} s for it to come back.`,
        );
      },
      onReconnected: () => {
        deps.error(
          "Reconnected to the Roughdraft server; waiting for Done Reviewing again.",
        );
      },
    });
  } catch (error) {
    if (!(error instanceof ReviewWatchConnectionLostError)) throw error;
    // The server died mid-round and never came back: say so instead of
    // throwing, so an agent in the loop knows to reopen rather than guess.
    const message = `Roughdraft server at ${serverUrl} did not come back within ${reconnectSeconds} s. This command cannot receive Done Reviewing for ${target.openPath}; run \`roughdraft open ${relativeDisplayPath(deps.cwd, target.openPath)}\` again to resume the review.`;
    if (json) {
      const disconnected = {
        disconnected: true,
        error: message,
        timedOut: false,
        events: [],
        ...(options.loop ? { done: false, doneReason: null } : {}),
      };
      if (options.comments) deps.log(JSON.stringify(disconnected));
      else emitJson(deps.log, disconnected);
    } else {
      deps.error(message);
    }
    return 1;
  }

  // A batch window can deliver several events in one round; the newest one
  // reflects the document's latest state, so it decides the done-signal.
  const latestEvent = (payload.events ?? []).at(-1) as
    | {
        doneReason?: ReviewDoneReason | null;
        summary?: { unresolved?: number };
      }
    | undefined;
  const doneReason = latestEvent?.doneReason ?? null;

  if (options.comments) {
    return reportCommentsWatch(deps, target.openPath, payload, options, json);
  }

  if (json) {
    emitJson(
      deps.log,
      options.loop
        ? { ...payload, done: doneReason !== null, doneReason }
        : payload,
    );
    return payload.timedOut ? 1 : 0;
  }

  if (payload.timedOut) {
    deps.log(`No review completed event received for ${target.openPath}.`);
    return 1;
  }

  deps.log(`Review completed for ${target.openPath}.`);
  deps.log(`Received ${(payload.events ?? []).length} event(s).`);
  if (options.loop) {
    deps.log(describeDoneSignal(doneReason, latestEvent?.summary?.unresolved));
  }
  return 0;
}

// `watch --comments`: one JSON line per new comment, or the review.completed
// line, as they came in this round. Exit codes as the plain watch.
function reportCommentsWatch(
  deps: CliDependencies,
  openPath: string,
  payload: Awaited<ReturnType<typeof waitForReviewEvents>>,
  options: ParsedWatchOptions,
  json: boolean,
): number {
  const events = (payload.events ?? []) as Array<
    ReviewCommentAddedEvent | ReviewCompletedEvent
  >;

  if (json) {
    if (payload.timedOut) {
      deps.log(JSON.stringify({ timedOut: true, events: [] }));
      return 1;
    }
    for (const event of events) {
      if (event.type === "comment.added") {
        for (const comment of event.comments) {
          deps.log(
            JSON.stringify({
              type: "comment.added",
              path: event.documentPath,
              id: comment.id,
              kind: comment.kind,
              parentId: comment.parentId,
              text: comment.text,
              anchorText: comment.anchorText,
              author: comment.author,
              sequence: event.sequence,
            }),
          );
        }
      } else {
        deps.log(
          JSON.stringify(
            options.loop
              ? {
                  ...event,
                  path: event.documentPath,
                  done: event.doneReason !== null,
                }
              : { ...event, path: event.documentPath },
          ),
        );
      }
    }
    return 0;
  }

  if (payload.timedOut) {
    deps.log(`No new comment or review completed event for ${openPath}.`);
    return 1;
  }

  for (const event of events) {
    if (event.type === "comment.added") {
      for (const comment of event.comments) {
        const where = comment.anchorText
          ? ` on "${comment.anchorText}"`
          : comment.parentId
            ? ` to ${comment.parentId}`
            : "";
        deps.log(
          `New ${comment.kind} ${comment.id}${where} in ${openPath}: ${comment.text}`,
        );
      }
    } else {
      deps.log(`Review completed for ${openPath}.`);
      if (options.loop) {
        deps.log(
          describeDoneSignal(event.doneReason, event.summary.unresolved),
        );
      }
    }
  }
  return 0;
}

// --- Tab windows: one window, a tab per document, a batch queue ---

interface TabOpenResultPayload {
  path: string;
  status: string;
  releaseAt?: string;
  windowId?: string;
}

interface TabOpenResponsePayload {
  results: TabOpenResultPayload[];
  url?: string;
  windowId?: string;
}

const TABS_API_TIMEOUT_MS = 10_000;

/** POSTs to a tab route; null when the server cannot answer (older server, down). */
async function postTabsApi(
  deps: CliDependencies,
  baseUrl: string,
  route: string,
  body: unknown,
): Promise<unknown | null> {
  try {
    const response = await deps.fetchImpl(new URL(route, baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TABS_API_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function isTabOpenResponse(value: unknown): value is TabOpenResponsePayload {
  if (!value || typeof value !== "object") return false;
  const results = (value as { results?: unknown }).results;
  return (
    Array.isArray(results) &&
    results.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { path?: unknown }).path === "string" &&
        typeof (entry as { status?: unknown }).status === "string",
    )
  );
}

function formatClockTime(iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "the next batch";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Shows a tab window: an Orca tab first, then the system opener. */
async function openTabWindowUrl(
  deps: CliDependencies,
  windowUrl: string,
): Promise<OpenMode> {
  return (await openInOrcaTab(deps, windowUrl)) ?? deps.openUrl(windowUrl);
}

/**
 * Today's single-document open: an Orca tab, or the open request a page that
 * already shows the file receives, or a new window.
 */
async function openSingleDocument(
  deps: CliDependencies,
  {
    baseUrl,
    targetUrl,
    openPath,
    sessionLabel,
  }: {
    baseUrl: string;
    targetUrl: string;
    openPath: string;
    sessionLabel: string | null;
  },
): Promise<OpenMode> {
  // Why: inside Orca the tab in the agent's worktree wins over reusing a
  // window that may be open elsewhere, so the review shows up where the
  // agent runs, desktop or Orca mobile.
  const orcaOpenMode = await openInOrcaTab(deps, targetUrl);
  if (orcaOpenMode === "existing-orca-tab") {
    // Orca only brings the reused tab forward; the open request is
    // what tells the page about the new session label.
    await sendOpenRequestToExistingWindow(
      deps,
      baseUrl,
      targetUrl,
      openPath,
      sessionLabel,
    );
  }
  return (
    orcaOpenMode ??
    ((await sendOpenRequestToExistingWindow(
      deps,
      baseUrl,
      targetUrl,
      openPath,
      sessionLabel,
    ))
      ? "existing-window"
      : deps.openUrl(targetUrl))
  );
}

interface MultiWatchOptions {
  batchWindowSeconds: number;
  replay: boolean;
  timeoutSeconds?: number;
  stateDir?: string;
  stateFile?: string;
  serverUrl?: string;
}

/**
 * `watch a.md b.md`: one line per file as it finishes, then {"allDone":true}
 * (JSON). Exit 0 when every file is done, 1 on a timeout or a lost server.
 */
async function runWatchMany(
  deps: CliDependencies,
  targetPaths: string[],
  options: MultiWatchOptions,
  json: boolean,
): Promise<number> {
  const targets = targetPaths.map((targetPath) => resolveTargetPath(targetPath));
  const first = targets[0];
  if (!first) return USAGE_ERROR;
  let serverUrl = options.serverUrl;
  if (!serverUrl) {
    const result = await ensureServerRunning(deps, {
      projectDir: first.projectDir,
    });
    serverUrl = result.server.url;
  }
  const reconnectSeconds = readReconnectWindowSeconds(deps.env);
  const pending = new Set(targets.map((target) => target.openPath));
  let failed = false;

  await Promise.all(
    targets.map(async (target) => {
      let payload: Awaited<ReturnType<typeof waitForReviewEvents>>;
      try {
        payload = await waitForReviewEvents({
          fetchImpl: deps.fetchImpl,
          serverUrl: serverUrl as string,
          target: {
            projectPath: target.projectDir,
            path: path.relative(target.projectDir, target.openPath),
            batchWindowSeconds: options.batchWindowSeconds,
          },
          timeoutSeconds: options.timeoutSeconds,
          fromNow: !options.replay,
          failureWindowMs: reconnectSeconds * 1000,
        });
      } catch (error) {
        if (!(error instanceof ReviewWatchConnectionLostError)) throw error;
        failed = true;
        if (json) {
          deps.log(
            JSON.stringify({
              path: target.openPath,
              disconnected: true,
              timedOut: false,
              events: [],
            }),
          );
        } else {
          deps.error(
            `Roughdraft server at ${serverUrl} did not come back within ${reconnectSeconds} s; ${target.openPath} cannot receive Done Reviewing. Run \`roughdraft open\` again to resume.`,
          );
        }
        return;
      }

      if (payload.timedOut) {
        failed = true;
        if (json) {
          deps.log(
            JSON.stringify({
              path: target.openPath,
              timedOut: true,
              events: [],
            }),
          );
        } else {
          deps.log(
            `No review completed event received for ${target.openPath}.`,
          );
        }
        return;
      }

      pending.delete(target.openPath);
      if (json) {
        deps.log(
          JSON.stringify({
            path: target.openPath,
            timedOut: false,
            events: payload.events ?? [],
          }),
        );
      } else {
        deps.log(`Review completed for ${target.openPath}.`);
      }
    }),
  );

  const allDone = !failed && pending.size === 0;
  if (json) {
    deps.log(
      JSON.stringify(
        allDone
          ? { allDone: true }
          : { allDone: false, pending: [...pending] },
      ),
    );
  } else if (allDone) {
    deps.log(`All ${targets.length} reviews completed.`);
  }
  return allDone ? 0 : 1;
}

const TABS_USAGE =
  "Usage: roughdraft tabs [--json] | tabs add|focus|close <path> [--window <id>] | tabs release [--json]";

/** `roughdraft tabs ...`: list, add, focus, close, release. */
async function runTabs(
  deps: CliDependencies,
  args: string[],
  globalJson: boolean,
): Promise<number> {
  let options: ParsedCommandOptions;
  try {
    options = parseCommandOptions(args, {
      allowOpen: true,
      allowSince: true,
      allowWindow: true,
    });
  } catch (error) {
    deps.error(error instanceof Error ? error.message : "Invalid usage.");
    return USAGE_ERROR;
  }
  if (options.help) {
    printCommandHelp("tabs", deps.log);
    return 0;
  }
  const json = globalJson || options.json;
  deps = applyCliEnvOverrides(deps, options);
  const [action, ...operands] = options.positionals;

  const server = await findReusableServer(deps);
  const notRunning = () => {
    if (json) {
      emitJson(deps.log, { running: false });
    } else {
      deps.log("Roughdraft is not running. Start it with `roughdraft start`.");
    }
    return 1;
  };

  if (!action) {
    if (!server) {
      if (json) {
        emitJson(deps.log, {
          running: false,
          windows: [],
          queue: { items: [], releaseAt: null, batchOpenedAt: null },
        });
        return 0;
      }
      return notRunning();
    }
    const baseUrl = buildPublicBaseUrl(server.port);
    let listing: {
      windows?: Array<{
        id: string;
        live?: boolean;
        tabs: Array<{ path: string; done: boolean; openThreads: number }>;
      }>;
      queue?: {
        items: Array<{ path: string }>;
        releaseAt: string | null;
        batchOpenedAt: string | null;
      };
    } | null = null;
    try {
      const response = await deps.fetchImpl(new URL("/api/tabs", baseUrl), {
        signal: AbortSignal.timeout(TABS_API_TIMEOUT_MS),
      });
      if (response.ok) listing = await response.json();
    } catch {}
    if (!listing) {
      deps.error("This Roughdraft server does not support tab windows.");
      return 1;
    }
    if (json) {
      emitJson(deps.log, { running: true, ...listing });
      return 0;
    }
    const windows = (listing.windows ?? []).filter((window) => window.live);
    if (windows.length === 0) deps.log("Windows: none open");
    for (const window of windows) {
      deps.log(`Window ${window.id}`);
      for (const tab of window.tabs) {
        deps.log(
          `  ${tab.path}${tab.done ? " (done)" : ""}${tab.openThreads > 0 ? ` (${tab.openThreads} open threads)` : ""}`,
        );
      }
    }
    const items = listing.queue?.items ?? [];
    if (items.length === 0) {
      deps.log("Queue: empty");
    } else {
      deps.log(
        `Queue: ${items.length} waiting for the next batch at ${formatClockTime(listing.queue?.releaseAt ?? undefined)}`,
      );
      for (const item of items) deps.log(`  ${item.path}`);
    }
    return 0;
  }

  if (action === "release") {
    if (operands.length > 0) {
      deps.error(TABS_USAGE);
      return USAGE_ERROR;
    }
    if (!server) return notRunning();
    const baseUrl = buildPublicBaseUrl(server.port);
    const payload = (await postTabsApi(deps, baseUrl, "/api/tabs/release", {
      open: false,
    })) as {
      released?: number;
      url?: string;
      windowId?: string;
    } | null;
    if (!payload || typeof payload.released !== "number") {
      deps.error("This Roughdraft server does not support tab windows.");
      return 1;
    }
    let openMode: OpenMode | null = null;
    if (payload.url && deps.env.ROUGHDRAFT_NO_OPEN !== "1") {
      try {
        openMode = await openTabWindowUrl(
          deps,
          new URL(payload.url, baseUrl).toString(),
        );
      } catch (error) {
        if (!(error instanceof OrcaTabRequiredError)) throw error;
        deps.error(error.message);
        return 1;
      }
    }
    if (json) {
      emitJson(deps.log, {
        released: payload.released,
        ...(payload.windowId ? { windowId: payload.windowId } : {}),
        ...(payload.url
          ? { url: new URL(payload.url, baseUrl).toString() }
          : {}),
        ...(openMode ? { openMode } : {}),
      });
      return 0;
    }
    deps.log(
      payload.released === 0
        ? "Nothing is queued."
        : `Released ${payload.released} queued document(s)${payload.url ? " in a new window" : " to the open window"}.`,
    );
    return 0;
  }

  if (action !== "add" && action !== "focus" && action !== "close") {
    deps.error(TABS_USAGE);
    return USAGE_ERROR;
  }
  if (operands.length !== 1) {
    deps.error(TABS_USAGE);
    return USAGE_ERROR;
  }
  let target: ResolvedTargetPath;
  try {
    target = resolveTargetPath(operands[0] ?? "");
  } catch (error) {
    deps.error(error instanceof Error ? error.message : "Invalid path.");
    return 1;
  }

  if (action === "add") {
    const ensured = await ensureServerRunning(deps, {
      projectDir: target.projectDir,
    });
    const baseUrl = buildPublicBaseUrl(ensured.server.port);
    const payload = await postTabsApi(deps, baseUrl, "/api/tabs/open", {
      tabs: [
        {
          path: target.openPath,
          ...(options.label?.trim() ? { label: options.label.trim() } : {}),
          ...(options.since?.trim() ? { since: options.since.trim() } : {}),
        },
      ],
      now: true,
      ...(options.window ? { windowId: options.window } : {}),
      orcaTarget: resolveOrcaTarget(deps.env),
    });
    if (!isTabOpenResponse(payload)) {
      deps.error("This Roughdraft server does not support tab windows.");
      return 1;
    }
    let openMode: OpenMode | null = null;
    const windowUrl = payload.url
      ? new URL(payload.url, baseUrl).toString()
      : null;
    if (windowUrl && !options.noOpen && deps.env.ROUGHDRAFT_NO_OPEN !== "1") {
      try {
        openMode = await openTabWindowUrl(deps, windowUrl);
      } catch (error) {
        if (!(error instanceof OrcaTabRequiredError)) throw error;
        deps.error(error.message);
        return 1;
      }
    }
    const status = payload.results[0]?.status ?? "added";
    if (json) {
      emitJson(deps.log, {
        path: target.openPath,
        status,
        ...(payload.windowId ? { windowId: payload.windowId } : {}),
        ...(windowUrl ? { url: windowUrl } : {}),
        ...(openMode ? { openMode } : {}),
      });
      return 0;
    }
    deps.log(
      windowUrl
        ? describeOpenedDocument(openMode ?? "disabled", windowUrl)
        : status === "focused"
          ? `Already open, focused: ${target.openPath}`
          : `Added to the open Roughdraft window: ${target.openPath}`,
    );
    return 0;
  }

  if (!server) return notRunning();
  const baseUrl = buildPublicBaseUrl(server.port);
  const payload = (await postTabsApi(deps, baseUrl, `/api/tabs/${action}`, {
    path: target.openPath,
    ...(options.window ? { windowId: options.window } : {}),
  })) as { focused?: boolean; closed?: boolean; from?: string } | null;
  if (!payload) {
    deps.error("This Roughdraft server does not support tab windows.");
    return 1;
  }
  const ok = action === "focus" ? payload.focused === true : payload.closed === true;
  if (json) {
    emitJson(deps.log, {
      path: target.openPath,
      [action === "focus" ? "focused" : "closed"]: ok,
      ...(payload.from ? { from: payload.from } : {}),
    });
    return ok ? 0 : 1;
  }
  deps.log(
    ok
      ? action === "focus"
        ? `Focused ${target.openPath}.`
        : `Closed ${target.openPath}${payload.from === "queue" ? " (removed from the queue)" : ""}.`
      : `${target.openPath} is not open in a Roughdraft window.`,
  );
  return ok ? 0 : 1;
}

const CHANGES_USAGE =
  "Usage: roughdraft changes <path> [--since <x>] [--json]";

/** `roughdraft changes <path>`: the document compared with a baseline. */
async function runChanges(
  deps: CliDependencies,
  args: string[],
  globalJson: boolean,
): Promise<number> {
  let options: ParsedCommandOptions;
  try {
    options = parseCommandOptions(args, { allowSince: true });
  } catch (error) {
    deps.error(error instanceof Error ? error.message : "Invalid usage.");
    return USAGE_ERROR;
  }
  if (options.help) {
    printCommandHelp("changes", deps.log);
    return 0;
  }
  if (options.positionals.length !== 1) {
    deps.error(CHANGES_USAGE);
    return USAGE_ERROR;
  }
  const json = globalJson || options.json;
  deps = applyCliEnvOverrides(deps, options);

  const absolutePath = path.resolve(deps.cwd, options.positionals[0] ?? "");
  if (!isMarkdownPath(absolutePath)) {
    deps.error(`Roughdraft can only read .md files: ${absolutePath}`);
    return 1;
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    deps.error(`Markdown file not found: ${absolutePath}`);
    return 1;
  }

  const projectDir = path.dirname(absolutePath);
  const ensured = await ensureServerRunning(deps, { projectDir });
  const baseUrl = buildPublicBaseUrl(ensured.server.port);
  const url = new URL("/api/document-baseline", baseUrl);
  url.searchParams.set("projectPath", projectDir);
  url.searchParams.set("path", path.basename(absolutePath));
  url.searchParams.set("since", options.since?.trim() || "last-review");

  let baseline: { source: string; label: string; content: string } | null = null;
  let failure = "";
  try {
    const response = await deps.fetchImpl(url, {
      signal: AbortSignal.timeout(TABS_API_TIMEOUT_MS),
    });
    if (response.ok) {
      const payload = (await response.json()) as Partial<{
        source: string;
        label: string;
        content: string;
      }>;
      if (typeof payload.content === "string") {
        baseline = {
          source: String(payload.source ?? "last-review"),
          label: String(payload.label ?? ""),
          content: payload.content,
        };
      }
    } else {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: unknown;
      };
      failure =
        typeof payload.error === "string"
          ? payload.error
          : `The server answered ${response.status}.`;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (!baseline) {
    const message = failure || "There is no baseline for this document.";
    if (json) emitJson(deps.log, { baseline: null, error: message });
    else deps.error(message);
    return 1;
  }

  const diff = diffRoughdraftDocuments(
    baseline.content,
    fs.readFileSync(absolutePath, "utf-8"),
  );
  if (json) {
    emitJson(deps.log, {
      ...diff,
      source: baseline.source,
      label: baseline.label,
    });
    return 0;
  }

  deps.log(`Baseline: ${baseline.label || baseline.source}`);
  if (diff.changes.length === 0) {
    deps.log("No changes.");
    return 0;
  }
  const { added, changed, removed } = diff.summary;
  deps.log(
    `${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}: ${added} added, ${changed} changed, ${removed} removed`,
  );
  for (const change of diff.changes) {
    const where = `line ${change.line}`;
    if (change.kind === "added") {
      deps.log(`  ${where}: added: ${change.newText}`);
    } else if (change.kind === "removed") {
      deps.log(`  ${where}: removed: ${change.oldText}`);
    } else {
      deps.log(`  ${where}: changed`);
      deps.log(`    was: ${change.oldText}`);
      deps.log(`    now: ${change.newText}`);
    }
  }
  return 0;
}

const REPLY_USAGE =
  "Usage: roughdraft reply <path> --to <id> [--by <name>] [--json] <text...>";

function runReply(
  deps: CliDependencies,
  args: string[],
  globalJson: boolean,
): number {
  let json = globalJson;
  let to: string | undefined;
  let by: string | undefined;
  const positionals: string[] = [];

  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (arg === "--") {
        positionals.push(...args.slice(index + 1));
        break;
      }
      if (arg === "-h" || arg === "--help") {
        printCommandHelp("reply", deps.log);
        return 0;
      }
      if (arg === "--json") {
        json = true;
      } else if (arg === "--to" || arg === "--by") {
        const next = takeFlagValue(args, index, arg);
        if (arg === "--to") to = next.value;
        else by = next.value;
        index = next.nextIndex;
      } else if (arg.startsWith("--to=")) {
        to = arg.slice("--to=".length);
      } else if (arg.startsWith("--by=")) {
        by = arg.slice("--by=".length);
      } else if (arg.startsWith("-") && arg.length > 1) {
        throw new Error(`Unknown flag: ${arg}`);
      } else {
        positionals.push(arg);
      }
    }
  } catch (error) {
    deps.error(error instanceof Error ? error.message : "Invalid usage.");
    return USAGE_ERROR;
  }

  const [file, ...textParts] = positionals;
  const message = textParts.join(" ").trim();
  if (!file || !to || to.trim().length === 0 || message.length === 0) {
    deps.error(REPLY_USAGE);
    return USAGE_ERROR;
  }

  const absolutePath = path.resolve(deps.cwd, file);
  if (!isMarkdownPath(absolutePath)) {
    deps.error(`Roughdraft can only edit .md files: ${absolutePath}`);
    return 1;
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    deps.error(`Markdown file not found: ${absolutePath}`);
    return 1;
  }

  try {
    const result = replyToComment(absolutePath, {
      parentId: to,
      message,
      author: by,
    });
    if (json) {
      deps.log(
        JSON.stringify({
          replied: true,
          id: result.id,
          parentId: result.parentId,
        }),
      );
    } else {
      deps.log(`Replied to ${result.parentId} in ${absolutePath}.`);
    }
    return 0;
  } catch (error) {
    deps.error(error instanceof Error ? error.message : "Could not reply.");
    return 1;
  }
}

const DEFAULT_RECONNECT_SECONDS = 120;

function readReconnectWindowSeconds(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.ROUGHDRAFT_WATCH_RECONNECT_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RECONNECT_SECONDS;
}

function describeDoneSignal(
  doneReason: ReviewDoneReason | null,
  unresolved: number | undefined,
): string {
  if (doneReason === "overall-comment") {
    return "Reviewer signaled done: the overall comment says the review is done.";
  }
  if (doneReason === "threads-cleared") {
    return "Reviewer signaled done: every thread is cleared.";
  }
  const openCount = typeof unresolved === "number" ? `${unresolved} ` : "";
  return `Review continues: ${openCount}item(s) still open and no done-signal. Act on the feedback and reopen the document.`;
}

function isMarkdownPath(targetPath: string): boolean {
  const extension = path.extname(targetPath).toLowerCase();
  return extension === ".md";
}

function relativeDisplayPath(cwd: string, absolutePath: string): string {
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath && !relativePath.startsWith("..")
    ? relativePath
    : absolutePath;
}

function formatMarkdownDiagnostic(diagnostic: RfmDiagnostic): string {
  return `  ${diagnostic.line}:${diagnostic.column}  ${diagnostic.message}`;
}

function getConfidentStopCandidate(
  payload: StatusPayload | null,
): number | null {
  if (
    typeof payload?.pid !== "number" ||
    !Number.isFinite(payload.pid) ||
    payload.pid <= 0 ||
    !payload.serverRoot ||
    path.resolve(payload.serverRoot) !== currentServerRoot
  ) {
    return null;
  }

  return payload.pid;
}

export async function runCli(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  let deps = createCliDependencies(overrides);
  let parsed: ParsedCli;
  let shouldPrintUpdateNotice = false;

  try {
    try {
      parsed = parseGlobalArgs(args);
    } catch (error) {
      deps.error(error instanceof Error ? error.message : "Invalid usage.");
      return USAGE_ERROR;
    }

    if (parsed.global.version) {
      deps.log(readPackageVersion());
      return 0;
    }

    if (!parsed.command) {
      printHelp(deps.log);
      return 0;
    }

    if (parsed.command === "help") {
      const [topic, ...extra] = parsed.rest;
      if (extra.length > 0) {
        deps.error("Usage: roughdraft help [agent|criticmarkup|command]");
        return USAGE_ERROR;
      }

      if (!topic) {
        printHelp(deps.log);
        return 0;
      }

      if (topic === "agent") {
        printAgentHelp(deps.log);
        return 0;
      }

      if (topic === "criticmarkup") {
        printCriticMarkupHelp(deps.log);
        return 0;
      }

      if (isKnownCommand(topic)) {
        printCommandHelp(topic, deps.log);
        return 0;
      }

      deps.error(`Unknown help topic: ${topic}`);
      return USAGE_ERROR;
    }

    let command = parsed.command;
    let rest = parsed.rest;

    if (!isKnownCommand(command)) {
      if (isPathLikeInput(command)) {
        rest = [command, ...rest];
        command = "open";
      } else {
        const suggestion = suggestCommand(command);
        deps.error(
          `Unknown command: ${command}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
        );
        return USAGE_ERROR;
      }
    }

    if (parsed.global.help) {
      printCommandHelp(command as KnownCommand, deps.log);
      return 0;
    }

    if (command === "criticmarkup") {
      shouldPrintUpdateNotice = true;
      printCriticMarkupHelp(deps.log);
      return 0;
    }

    if (command === "agent-setup") {
      shouldPrintUpdateNotice = true;
      printAgentHelp(deps.log);
      return 0;
    }

    if (command === "start") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, { allowPort: true });
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("start", deps.log);
        return 0;
      }

      if (options.positionals.length > 0) {
        deps.error("Usage: roughdraft start [--port <port>] [--json]");
        return USAGE_ERROR;
      }

      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      shouldPrintUpdateNotice = !json;
      const result = await ensureServerRunning(deps);
      if (json) {
        emitJson(deps.log, {
          ...buildServerStatusJson(
            result.server,
            getServerStateFilePath(deps.env),
          ),
          reused: result.reused,
          portChanged: result.portChanged,
        });
        return 0;
      }

      if (result.reused) {
        if (result.server.tracked) {
          deps.log(`Roughdraft is already running at ${result.server.url}`);
        } else {
          deps.log(
            `Roughdraft is already running at ${result.server.url}, but it is not managed by ${getServerStateFilePath(deps.env)}.`,
          );
        }
        return 0;
      }

      if (result.portChanged) {
        deps.log(
          `Preferred port ${getPreferredPort(deps.env)} is busy, using ${result.server.port}.`,
        );
      }

      deps.log(`Roughdraft running at ${result.server.url}`);
      return 0;
    }

    if (command === "status") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, {});
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("status", deps.log);
        return 0;
      }

      if (options.positionals.length > 1) {
        deps.error("Usage: roughdraft status [<path>] [--json]");
        return USAGE_ERROR;
      }

      const documentPath =
        options.positionals[0] !== undefined
          ? path.resolve(deps.cwd, options.positionals[0])
          : null;
      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      shouldPrintUpdateNotice = !json;
      const stateFilePath = getServerStateFilePath(deps.env);
      const server = await findReusableServer(deps);
      if (!server) {
        if (json) {
          emitJson(deps.log, {
            ...buildServerStatusJson(null, stateFilePath),
            ...(documentPath
              ? { document: { path: documentPath, open: false } }
              : {}),
          });
          return 0;
        }

        deps.log(
          "Roughdraft is not running. Start it with `roughdraft start`.",
        );
        return 1;
      }

      if (documentPath) {
        const document = await describeOpenDocument(server, documentPath, deps);
        if (json) {
          emitJson(deps.log, {
            ...buildServerStatusJson(server, stateFilePath),
            document: document ?? { path: documentPath, open: false },
          });
          return document?.threadsError ? 1 : 0;
        }

        deps.log(`Roughdraft is running at ${server.url}`);
        printServerProcessLines(deps, server, stateFilePath);
        if (!document) {
          deps.log(`${documentPath} is not open in Roughdraft.`);
          return 1;
        }

        deps.log(`Document: ${document.path}`);
        deps.log(formatSessionLine(document.sessionLabel));
        deps.log(`Opened: ${document.openedAt}`);
        const olderTabs = document.tabs.slice(0, -1);
        if (olderTabs.length > 0) {
          deps.log(
            `Also open in: ${olderTabs
              .map(
                (tab) =>
                  `${tab.sessionLabel ?? "no label given"} (opened ${tab.openedAt})`,
              )
              .join(", ")}`,
          );
        }
        deps.log(`Last save: ${document.lastSavedAt ?? "none since opened"}`);
        if (!document.openThreads) {
          deps.error(
            `Could not read the review index for ${documentPath}: ${document.threadsError}`,
          );
          return 1;
        }
        deps.log(
          document.openThreads.count === 0
            ? "Open threads: 0"
            : `Open threads: ${document.openThreads.count} (${document.openThreads.ids.join(", ")})`,
        );
        return 0;
      }

      if (json) {
        emitJson(deps.log, {
          ...buildServerStatusJson(server, stateFilePath),
          documents: server.documents,
        });
        return 0;
      }

      deps.log(`Roughdraft is running at ${server.url}`);
      printServerProcessLines(deps, server, stateFilePath);
      if (server.documents.length === 0) {
        deps.log("Document: none open");
      }
      for (const document of server.documents) {
        deps.log(`Document: ${document.path}`);
        deps.log(formatSessionLine(document.sessionLabel));
      }
      return 0;
    }

    if (command === "stop") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, { allowAll: true });
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("stop", deps.log);
        return 0;
      }

      if (options.positionals.length > 0) {
        deps.error("Usage: roughdraft stop [--all]");
        return USAGE_ERROR;
      }

      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      shouldPrintUpdateNotice = !json;
      const stateFilePath = getServerStateFilePath(deps.env);
      const stopResult = await stopTrackedServer(deps);

      if (!stopResult.persistedState) {
        const preferredPort = getPreferredPort(deps.env);
        const unmanagedServer = await getStatusPayload(preferredPort, deps);
        if (unmanagedServer) {
          const candidatePid = options.all
            ? getConfidentStopCandidate(unmanagedServer)
            : null;
          if (candidatePid !== null) {
            await deps.stopProcess(candidatePid);
            const stopped = await waitForServerToStop(preferredPort, deps);
            if (stopped) {
              if (json) {
                emitJson(deps.log, {
                  stopped: true,
                  managed: false,
                  pid: candidatePid,
                  url: buildPublicBaseUrl(preferredPort),
                  stateFile: stateFilePath,
                });
                return 0;
              }

              deps.log(
                `Stopped unmanaged Roughdraft at ${buildPublicBaseUrl(preferredPort)}.`,
              );
              return 0;
            }
          }

          if (json) {
            emitJson(deps.log, {
              stopped: false,
              managed: false,
              url: buildPublicBaseUrl(preferredPort),
              ...(options.all
                ? { reason: "No confident unmanaged process candidate." }
                : {}),
              stateFile: stateFilePath,
            });
            return 1;
          }

          deps.error(
            options.all
              ? `Roughdraft is still running at ${buildPublicBaseUrl(preferredPort)}, but it could not be matched to a safe process candidate. Stop it manually.`
              : `Roughdraft is still running at ${buildPublicBaseUrl(preferredPort)}, but it is not managed by ${stateFilePath}. Stop it manually.`,
          );
          return 1;
        }

        if (json) {
          emitJson(deps.log, {
            stopped: false,
            running: false,
            stateFile: stateFilePath,
          });
          return 0;
        }

        deps.log("Roughdraft is not running.");
        return 0;
      }

      if (stopResult.failedPid !== null) {
        if (json) {
          emitJson(deps.log, {
            stopped: false,
            pid: stopResult.failedPid,
            stateFile: stateFilePath,
          });
          return 1;
        }

        deps.error(
          `Failed to stop Roughdraft process ${stopResult.failedPid}.`,
        );
        return 1;
      }

      if (!stopResult.portIsQuiet) {
        if (options.all) {
          const unmanagedServer = await getStatusPayload(
            stopResult.persistedState.port,
            deps,
          );
          const candidatePid = getConfidentStopCandidate(unmanagedServer);
          if (candidatePid !== null) {
            await deps.stopProcess(candidatePid);
            const stopped = await waitForServerToStop(
              stopResult.persistedState.port,
              deps,
            );
            if (stopped) {
              if (json) {
                emitJson(deps.log, {
                  stopped: true,
                  pid: stopResult.persistedState.pid,
                  unmanagedPid: candidatePid,
                  url: buildPublicBaseUrl(stopResult.persistedState.port),
                  stateFile: stateFilePath,
                });
                return 0;
              }

              deps.log(
                `Stopped Roughdraft at ${buildPublicBaseUrl(stopResult.persistedState.port)}.`,
              );
              deps.log(`Stopped unmanaged Roughdraft process ${candidatePid}.`);
              return 0;
            }
          }
        }

        if (json) {
          emitJson(deps.log, {
            stopped: true,
            pid: stopResult.persistedState.pid,
            url: buildPublicBaseUrl(stopResult.persistedState.port),
            anotherInstanceRunning: true,
            ...(options.all
              ? { reason: "No confident unmanaged process candidate." }
              : {}),
            stateFile: stateFilePath,
          });
          return 1;
        }

        deps.error(
          `Stopped tracked Roughdraft process ${stopResult.persistedState.pid}, but another Roughdraft instance is still running at ${buildPublicBaseUrl(stopResult.persistedState.port)}.`,
        );
        return 1;
      }

      if (json) {
        emitJson(deps.log, {
          stopped: true,
          pid: stopResult.persistedState.pid,
          url: buildPublicBaseUrl(stopResult.persistedState.port),
          stateFile: stateFilePath,
        });
        return 0;
      }

      deps.log(
        `Stopped Roughdraft at ${buildPublicBaseUrl(stopResult.persistedState.port)}.`,
      );
      return 0;
    }

    if (command === "watch") {
      let options: ParsedWatchOptions;
      try {
        options = parseWatchOptions(rest);
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("watch", deps.log);
        return 0;
      }

      if (options.positionals.length < 1) {
        deps.error("Usage: roughdraft watch <path> [<path>...] [--comments] [--json]");
        return USAGE_ERROR;
      }

      deps = applyWatchEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      shouldPrintUpdateNotice = !json;
      if (options.positionals.length > 1) {
        if (options.comments || options.afterSequence !== undefined) {
          deps.error(
            "--comments and --after work on one file: watch the files one at a time.",
          );
          return USAGE_ERROR;
        }
        return runWatchMany(
          deps,
          options.positionals,
          {
            batchWindowSeconds: options.batchWindowSeconds,
            replay: options.replay,
            timeoutSeconds: options.timeoutSeconds,
          },
          json,
        );
      }
      return runWatch(deps, options.positionals[0] ?? "", options, json);
    }

    if (command === "reply") {
      return runReply(deps, rest, parsed.global.json);
    }

    if (command === "mcp") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, {});
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }
      if (options.help) {
        printCommandHelp("mcp", deps.log);
        return 0;
      }
      if (options.positionals.length > 0) {
        deps.error("Usage: roughdraft mcp");
        return USAGE_ERROR;
      }

      const { startMcpServer } = await import("./mcp.js");
      startMcpServer({ env: deps.env, fetchImpl: deps.fetchImpl });
      return new Promise<number>(() => {});
    }

    if (command === "doctor") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, {});
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("doctor", deps.log);
        return 0;
      }

      if (options.positionals.length > 1) {
        deps.error("Usage: roughdraft doctor [path] [--json]");
        return USAGE_ERROR;
      }

      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      if (options.positionals.length === 1) {
        return runMarkdownDoctor(deps, options.positionals[0] ?? "", json);
      }

      shouldPrintUpdateNotice = !json;
      return runDoctor(deps, json);
    }

    if (command === "open") {
      let options: ParsedCommandOptions;
      try {
        options = parseCommandOptions(rest, {
          allowOpen: true,
          allowPort: true,
          allowSince: true,
          allowWatch: true,
        });
      } catch (error) {
        deps.error(error instanceof Error ? error.message : "Invalid usage.");
        return USAGE_ERROR;
      }

      if (options.help) {
        printCommandHelp("open", deps.log);
        return 0;
      }

      const targets = options.positionals;
      const target = targets[0];
      if (!target) {
        deps.error("Usage: roughdraft open <path> [<path>...]");
        return USAGE_ERROR;
      }
      const several = targets.length > 1;

      if (options.watch && options.noWatch) {
        deps.error("Use either --watch or --no-watch, not both.");
        return USAGE_ERROR;
      }

      if (options.watch && options.printUrl) {
        deps.error("Use either --watch or --print-url, not both.");
        return USAGE_ERROR;
      }

      if (options.loop && options.noWatch) {
        deps.error("Use either --loop or --no-watch, not both.");
        return USAGE_ERROR;
      }

      if (options.loop && options.printUrl) {
        deps.error("Use either --loop or --print-url, not both.");
        return USAGE_ERROR;
      }

      if (options.comments && (options.noWatch || options.printUrl)) {
        deps.error(
          "--comments needs the watch: do not combine it with --no-watch or --print-url.",
        );
        return USAGE_ERROR;
      }

      if (
        several &&
        (options.loop || options.comments || options.afterSequence !== undefined)
      ) {
        deps.error(
          "--loop, --comments and --after work on one file: open the files one by one, or watch them with `roughdraft watch a.md b.md`.",
        );
        return USAGE_ERROR;
      }

      deps = applyCliEnvOverrides(deps, options);
      const json = parsed.global.json || options.json;
      const resolvedTargets: ResolvedTargetPath[] = [];
      for (const entry of targets) {
        try {
          resolvedTargets.push(resolveTargetPath(entry));
        } catch (error) {
          deps.error(error instanceof Error ? error.message : "Invalid path.");
          return 1;
        }
      }

      const { projectDir, openPath } = resolvedTargets[0] as ResolvedTargetPath;
      const sessionLabel = options.label?.trim() || null;
      const since = options.since?.trim() || null;

      const remoteHost =
        typeof deps.env.ROUGHDRAFT_HOST === "string"
          ? deps.env.ROUGHDRAFT_HOST.trim()
          : "";
      if (remoteHost.length > 0) {
        if (several) {
          deps.error(
            "ROUGHDRAFT_HOST opens one file at a time: a remote session has no tab window.",
          );
          return USAGE_ERROR;
        }
        if (options.loop) {
          deps.error(
            "--loop is not supported with ROUGHDRAFT_HOST: a remote session never receives Done Reviewing.",
          );
          return USAGE_ERROR;
        }
        return runRemoteOpen(deps, {
          host: remoteHost,
          openPath,
          noOpen: options.noOpen,
          printUrl: options.printUrl,
          json,
        });
      }

      const liveDevFrontend = await resolveLiveDevFrontendBaseUrl(deps);
      let result: EnsureRunningResult | null = null;
      let baseUrl: string;

      if (liveDevFrontend) {
        baseUrl = liveDevFrontend.frontendUrl;
      } else {
        result = await ensureServerRunning(deps, { projectDir });
        baseUrl = buildPublicBaseUrl(result.server.port);
      }

      const targetUrl = buildTargetUrl(baseUrl, openPath, sessionLabel, since);
      if (!several) {
        warnBeforeReusingAnotherSessionsTab(
          deps,
          result?.server.documents ?? [],
          openPath,
          sessionLabel,
        );
      }
      let openMode: OpenMode = "disabled";
      let tabResults: TabOpenResultPayload[] | null = null;
      let windowUrl: string | null = null;
      if (!options.noOpen && deps.env.ROUGHDRAFT_NO_OPEN !== "1") {
        try {
          const tabsResponse = await postTabsApi(
            deps,
            baseUrl,
            "/api/tabs/open",
            {
              tabs: resolvedTargets.map((entry) => ({
                path: entry.openPath,
                ...(sessionLabel ? { label: sessionLabel } : {}),
                ...(since ? { since } : {}),
              })),
              ...(options.now ? { now: true } : {}),
              orcaTarget: resolveOrcaTarget(deps.env),
            },
          );
          if (isTabOpenResponse(tabsResponse)) {
            tabResults = tabsResponse.results;
            if (tabsResponse.url) {
              windowUrl = new URL(tabsResponse.url, baseUrl).toString();
              openMode = await openTabWindowUrl(deps, windowUrl);
            } else if (
              tabResults.some(
                (entry) => entry.status === "added" || entry.status === "focused",
              )
            ) {
              openMode = "existing-window";
            } else {
              openMode = "none";
            }
            // A plain page that already shows the file keeps today's delivery.
            for (const entry of tabResults) {
              if (entry.status !== "single-page") continue;
              openMode = await openSingleDocument(deps, {
                baseUrl,
                targetUrl: buildTargetUrl(baseUrl, entry.path, sessionLabel, since),
                openPath: entry.path,
                sessionLabel,
              });
            }
          } else if (several) {
            deps.error(
              "This Roughdraft server does not support tab windows: restart it, or open the files one by one.",
            );
            return 1;
          } else {
            openMode = await openSingleDocument(deps, {
              baseUrl,
              targetUrl,
              openPath,
              sessionLabel,
            });
          }
        } catch (error) {
          if (!(error instanceof OrcaTabRequiredError)) throw error;
          deps.error(error.message);
          return 1;
        }
      }

      if (result?.portChanged) {
        const message = `Preferred port ${getPreferredPort(deps.env)} is busy, using ${result.server.port}.`;
        if (options.printUrl) {
          deps.error(message);
        } else if (!json) {
          deps.log(message);
        }
      }

      if (options.printUrl) {
        for (const entry of resolvedTargets) {
          deps.log(buildTargetUrl(baseUrl, entry.openPath, sessionLabel, since));
        }
        return 0;
      }

      const queued = (tabResults ?? []).filter(
        (entry) => entry.status === "queued",
      );
      const shownUrl = windowUrl ?? targetUrl;
      const describeTabs = () => {
        for (const entry of tabResults ?? []) {
          const name = several
            ? ` ${relativeDisplayPath(deps.cwd, entry.path)}`
            : "";
          if (entry.status === "queued") {
            deps.log(
              `Queued${name} for the next batch at ${formatClockTime(entry.releaseAt)}.`,
            );
          } else if (entry.status === "added") {
            deps.log(
              `Added${name || ""} to the open Roughdraft window${name ? "" : `: ${entry.path}`}.`,
            );
          } else if (entry.status === "focused") {
            deps.log(
              `Already open${name}, focused in the Roughdraft window${name ? "" : `: ${entry.path}`}.`,
            );
          }
        }
        if (windowUrl) deps.log(describeOpenedDocument(openMode, windowUrl));
      };
      const describeAll = () => {
        if (tabResults === null) {
          deps.log(describeOpenedDocument(openMode, shownUrl));
        } else if (
          tabResults.length > 0 &&
          tabResults.every((entry) => entry.status === "single-page")
        ) {
          deps.log(describeOpenedDocument(openMode, targetUrl));
        } else {
          describeTabs();
        }
      };

      const shouldWatch = !options.noWatch && !options.printUrl;

      if (shouldWatch) {
        if (!json) {
          describeAll();
          deps.log("Waiting for Done Reviewing...");
        } else {
          for (const entry of queued) {
            deps.log(
              JSON.stringify({
                queued: true,
                releaseAt: entry.releaseAt ?? null,
                path: entry.path,
              }),
            );
          }
        }

        shouldPrintUpdateNotice = false;
        if (several) {
          return runWatchMany(
            deps,
            targets,
            {
              batchWindowSeconds: options.batchWindowSeconds,
              replay: options.replay,
              timeoutSeconds: options.timeoutSeconds,
              serverUrl: liveDevFrontend?.apiUrl ?? undefined,
            },
            json,
          );
        }
        const watchOptions: ParsedWatchOptions = {
          batchWindowSeconds: options.batchWindowSeconds,
          batchWindowExplicit: options.batchWindowExplicit,
          comments: options.comments,
          afterSequence: options.afterSequence,
          help: false,
          json,
          loop: options.loop,
          positionals: [target],
          replay: options.replay,
          serverUrl: liveDevFrontend?.apiUrl ?? undefined,
          stateDir: options.stateDir,
          stateFile: options.stateFile,
          timeoutSeconds: options.timeoutSeconds,
        };
        return runWatch(deps, target, watchOptions, json);
      }

      if (json) {
        if (several) {
          emitJson(deps.log, {
            opened: tabResults?.some((entry) => entry.status !== "queued") ?? true,
            serverUrl: baseUrl,
            ...(windowUrl ? { url: windowUrl } : {}),
            openMode,
            tabs:
              tabResults ??
              resolvedTargets.map((entry) => ({ path: entry.openPath })),
          });
          return 0;
        }
        const only = tabResults?.[0];
        if (only?.status === "queued") {
          emitJson(deps.log, {
            queued: true,
            releaseAt: only.releaseAt ?? null,
            path: openPath,
          });
          return 0;
        }
        emitJson(deps.log, {
          opened: true,
          url: shownUrl,
          serverUrl: baseUrl,
          path: openPath,
          openMode,
        });
        return 0;
      }

      shouldPrintUpdateNotice = true;
      describeAll();
      return 0;
    }

    if (command === "tabs") {
      return runTabs(deps, rest, parsed.global.json);
    }

    if (command === "changes") {
      return runChanges(deps, rest, parsed.global.json);
    }

    return USAGE_ERROR;
  } finally {
    if (shouldPrintUpdateNotice) {
      await printUpdateNoticeIfAvailable(deps);
    }
  }
}
