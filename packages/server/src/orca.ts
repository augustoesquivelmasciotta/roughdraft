/**
 * Showing documents as Orca browser tabs.
 *
 * Inside an Orca terminal (https://github.com/stablyai/orca), `roughdraft open`
 * shows the document in a browser tab of the agent's worktree instead of a
 * separate browser window. Orca mobile renders those tabs as a live view of
 * the page running on the computer, so the same tab can be reviewed from a
 * phone with no extra network setup.
 *
 * Everything goes through the `orca` CLI, so Roughdraft depends on no Orca
 * internals: list the worktree's tabs, reuse the one already showing the
 * document or create one, then bring it forward. A CLI-created Orca tab never
 * takes focus on its own; `tab switch --focus` is what surfaces it, and Orca
 * only does that when the user is already looking at that worktree.
 */
import { spawn } from "node:child_process";

export interface OrcaCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not start or ran past its timeout. */
  error?: string;
  timedOut?: boolean;
}

export type RunOrcaCommand = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<OrcaCommandResult>;

interface OrcaTarget {
  /** The Orca CLI to run. */
  command: string;
  /** `--worktree` selector for the terminal's worktree; null lets Orca use the cwd. */
  worktree: string | null;
}

type OrcaTabOpenResult =
  | { opened: true; reused: boolean; browserPageId: string | null }
  | { opened: false; reason: string };

type OrcaTabCloseResult = { closed: true } | { closed: false; reason: string };

interface OrcaBrowserTab {
  browserPageId: string;
  url: string;
  active: boolean;
  loadError: unknown;
}

type OrcaReply =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: string; timedOut?: boolean };

const LIST_TIMEOUT_MS = 10_000;
// Why: when the worktree has no live browser tab, Orca's `tab list` waits up
// to 8 s for saved tabs to load before answering. That is the common case for
// a first review, so stop looking early and create the tab instead.
const LOOKUP_TIMEOUT_MS = 2_500;
// Why: `tab create` returns once the page has loaded, so it needs more room.
const CREATE_TIMEOUT_MS = 30_000;

/**
 * Where `roughdraft open` should put an Orca tab, or null to keep using the
 * regular browser. Orca exports `ORCA_WORKTREE_ID` (`<repoId>::<path>`) in its
 * terminals, and agents launched there inherit it.
 */
export function resolveOrcaTarget(env: NodeJS.ProcessEnv): OrcaTarget | null {
  const preference = env.ROUGHDRAFT_ORCA?.trim();
  if (preference === "0") return null;

  const worktreeId = env.ORCA_WORKTREE_ID?.trim();
  const insideOrca =
    Boolean(worktreeId) ||
    Boolean(env.ORCA_WORKSPACE_ID?.trim()) ||
    env.TERM_PROGRAM === "Orca";
  if (!insideOrca && preference !== "1") return null;

  return {
    // Why: Orca's managed WSL shells name the CLI `orca-ide`, not `orca`.
    command: env.ORCA_CLI_COMMAND?.trim() || "orca",
    worktree: worktreeId ? `id:${worktreeId}` : null,
  };
}

function documentIdentity(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const documentPath = parsed.searchParams.get("path");
  const remoteSession = parsed.searchParams.get("session");
  const key = documentPath
    ? `path:${documentPath}`
    : remoteSession
      ? `session:${remoteSession}`
      : null;
  return key ? `${parsed.origin}${parsed.pathname}\n${key}` : null;
}

/**
 * True when both URLs show the same document on the same Roughdraft server.
 * View state such as `editor=code` or a hash does not make a different tab.
 */
export function isSameRoughdraftDocument(left: string, right: string): boolean {
  const leftIdentity = documentIdentity(left);
  return leftIdentity !== null && leftIdentity === documentIdentity(right);
}

function parseOrcaReply(output: OrcaCommandResult): OrcaReply {
  if (output.error) {
    return { ok: false, reason: output.error, timedOut: output.timedOut };
  }

  let payload: {
    ok?: unknown;
    result?: unknown;
    error?: { message?: unknown; code?: unknown };
  } | null = null;
  try {
    payload = JSON.parse(output.stdout);
  } catch {}

  if (
    payload?.ok === true &&
    payload.result &&
    typeof payload.result === "object"
  ) {
    return { ok: true, result: payload.result as Record<string, unknown> };
  }

  const message =
    typeof payload?.error?.message === "string"
      ? payload.error.message
      : typeof payload?.error?.code === "string"
        ? payload.error.code
        : output.stderr.trim() || `orca exited with code ${output.exitCode}`;
  return { ok: false, reason: message };
}

function readTabs(result: Record<string, unknown>): OrcaBrowserTab[] {
  const tabs = Array.isArray(result.tabs) ? result.tabs : [];
  return tabs.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.browserPageId !== "string" ||
      typeof record.url !== "string"
    ) {
      return [];
    }
    return [
      {
        browserPageId: record.browserPageId,
        url: record.url,
        active: record.active === true,
        loadError: record.loadError ?? null,
      },
    ];
  });
}

async function listTabs(
  run: RunOrcaCommand,
  command: string,
  worktree: string | null,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<
  | { ok: true; tabs: OrcaBrowserTab[] }
  | { ok: false; reason: string; timedOut?: boolean }
> {
  const reply = parseOrcaReply(
    await run(
      command,
      ["tab", "list", ...(worktree ? ["--worktree", worktree] : []), "--json"],
      { timeoutMs },
    ),
  );
  return reply.ok ? { ok: true, tabs: readTabs(reply.result) } : reply;
}

async function bringForward(
  run: RunOrcaCommand,
  command: string,
  browserPageId: string,
) {
  // Why: the tab exists either way; failing to focus it is not worth a fallback
  // that would open the document a second time.
  await run(
    command,
    ["tab", "switch", "--page", browserPageId, "--focus", "--json"],
    { timeoutMs: LIST_TIMEOUT_MS },
  ).catch(() => undefined);
}

/**
 * Shows `url` in an Orca browser tab of the target worktree: the tab that
 * already shows that document when there is one, a new tab otherwise.
 */
export async function openOrcaTab({
  target,
  url,
  run,
}: {
  target: OrcaTarget;
  url: string;
  run: RunOrcaCommand;
}): Promise<OrcaTabOpenResult> {
  const { command, worktree } = target;

  let listed: Awaited<ReturnType<typeof listTabs>>;
  try {
    listed = await listTabs(run, command, worktree, LOOKUP_TIMEOUT_MS);
  } catch (error) {
    return { opened: false, reason: errorMessage(error) };
  }
  if (!listed.ok && !listed.timedOut) {
    return { opened: false, reason: listed.reason };
  }

  // A lookup that ran out of time means no open tab to reuse.
  const existing = listed.ok
    ? listed.tabs.find((candidate) =>
        isSameRoughdraftDocument(candidate.url, url),
      )
    : undefined;
  if (existing) {
    if (existing.loadError) {
      // Why: a tab left on an error page (for example from a server restart)
      // would otherwise come forward still showing the error.
      await run(
        command,
        ["reload", "--page", existing.browserPageId, "--json"],
        { timeoutMs: CREATE_TIMEOUT_MS },
      ).catch(() => undefined);
    }
    await bringForward(run, command, existing.browserPageId);
    return {
      opened: true,
      reused: true,
      browserPageId: existing.browserPageId,
    };
  }

  let created: OrcaReply;
  try {
    created = parseOrcaReply(
      await run(
        command,
        [
          "tab",
          "create",
          "--url",
          url,
          ...(worktree ? ["--worktree", worktree] : []),
          "--json",
        ],
        { timeoutMs: CREATE_TIMEOUT_MS },
      ),
    );
  } catch (error) {
    created = { ok: false, reason: errorMessage(error) };
  }

  let browserPageId =
    created.ok && typeof created.result.browserPageId === "string"
      ? created.result.browserPageId
      : null;

  if (!browserPageId) {
    // Why: a create that timed out may still have made the tab. Opening the
    // browser on top of it would show the document twice.
    const relisted = await listTabs(run, command, worktree).catch(() => null);
    browserPageId =
      (relisted?.ok
        ? relisted.tabs.find((candidate) =>
            isSameRoughdraftDocument(candidate.url, url),
          )?.browserPageId
        : null) ?? null;
    if (!browserPageId) {
      return {
        opened: false,
        reason: created.ok ? "Orca did not return a tab id" : created.reason,
      };
    }
  }

  await bringForward(run, command, browserPageId);
  return { opened: true, reused: false, browserPageId };
}

/**
 * Closes the Orca tab showing `url`, the page that asked to be closed.
 * `window.close()` does nothing inside an Orca tab, so the page asks the
 * server to do it. When the page is open in several tabs, only the active one
 * is closed; if that still leaves a tie, nothing is.
 */
export async function closeOrcaTabShowing({
  command,
  url,
  run,
}: {
  command: string;
  url: string;
  run: RunOrcaCommand;
}): Promise<OrcaTabCloseResult> {
  let listed: Awaited<ReturnType<typeof listTabs>>;
  try {
    listed = await listTabs(run, command, "all");
  } catch (error) {
    return { closed: false, reason: errorMessage(error) };
  }
  if (!listed.ok) return { closed: false, reason: listed.reason };

  const exact = listed.tabs.filter((candidate) => candidate.url === url);
  const matches =
    exact.length > 0
      ? exact
      : listed.tabs.filter((candidate) =>
          isSameRoughdraftDocument(candidate.url, url),
        );
  if (matches.length === 0) return { closed: false, reason: "not-found" };

  const activeMatches = matches.filter((candidate) => candidate.active);
  const chosen =
    matches.length === 1
      ? matches[0]
      : activeMatches.length === 1
        ? activeMatches[0]
        : null;
  if (!chosen) return { closed: false, reason: "ambiguous" };

  let reply: OrcaReply;
  try {
    reply = parseOrcaReply(
      await run(
        command,
        ["tab", "close", "--page", chosen.browserPageId, "--json"],
        { timeoutMs: LIST_TIMEOUT_MS },
      ),
    );
  } catch (error) {
    reply = { ok: false, reason: errorMessage(error) };
  }
  return reply.ok ? { closed: true } : { closed: false, reason: reply.reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs the Orca CLI without a shell, capturing its output. Never throws. */
export const runOrcaCommand: RunOrcaCommand = (command, args, { timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: OrcaCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        exitCode: null,
        stdout,
        stderr,
        error: `timed out after ${timeoutMs} ms`,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ exitCode: null, stdout, stderr, error: error.message });
    });
    child.on("close", (exitCode) => {
      finish({ exitCode, stdout, stderr });
    });
  });
