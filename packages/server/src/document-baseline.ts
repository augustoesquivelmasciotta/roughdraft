import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BASELINE_BYTES = 10 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

export interface ResolvedBaseline {
  source: "file" | "git";
  label: string;
  content: string;
}

export type BaselineResolution =
  | { ok: true; baseline: ResolvedBaseline }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Turns a raw `since` value (not `last-review`) into baseline text: an existing
 * file inside the project (relative to the document's directory, or absolute),
 * else a git ref of the document's repository.
 */
export async function resolveDocumentBaseline(options: {
  projectDir: string;
  documentPath: string;
  since: string;
}): Promise<BaselineResolution> {
  const raw = options.since.trim();
  const documentDir = path.dirname(options.documentPath);
  const candidate = path.resolve(documentDir, raw);

  const fileResult = readProjectFile(options.projectDir, candidate);
  if (fileResult.kind === "outside") {
    return {
      ok: false,
      status: 403,
      error: `The baseline file is outside the project: ${raw}`,
    };
  }
  if (fileResult.kind === "content") {
    return {
      ok: true,
      baseline: {
        source: "file",
        label: path.relative(options.projectDir, candidate) || raw,
        content: fileResult.content,
      },
    };
  }

  const refError = validateGitRef(raw);
  if (refError) return { ok: false, status: 400, error: refError };
  return readGitBaseline(options.documentPath, raw);
}

function readProjectFile(
  projectDir: string,
  candidate: string,
):
  | { kind: "content"; content: string }
  | { kind: "outside" }
  | { kind: "none" } {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(candidate);
    stat = fs.statSync(real);
  } catch {
    return { kind: "none" };
  }
  if (!stat.isFile()) return { kind: "none" };

  let realProject: string;
  try {
    realProject = fs.realpathSync(projectDir);
  } catch {
    return { kind: "none" };
  }
  const relative = path.relative(realProject, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { kind: "outside" };
  }
  if (stat.size > MAX_BASELINE_BYTES) return { kind: "none" };
  return { kind: "content", content: fs.readFileSync(real, "utf-8") };
}

/** A ref is one plain revision: no option lookalike, no `ref:path`, no spaces. */
function validateGitRef(ref: string): string | null {
  if (!ref) return "since is empty.";
  if (ref.startsWith("-")) return `Not a valid git ref: ${ref}`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/[\s:\u0000-\u001f\u007f]/.test(ref)) {
    return `Not a valid git ref: ${ref}`;
  }
  return null;
}

async function readGitBaseline(
  documentPath: string,
  ref: string,
): Promise<BaselineResolution> {
  const notFound = (detail: string): BaselineResolution => ({
    ok: false,
    status: 404,
    error: `No baseline for "${ref}": not a file in the project, and ${detail}`,
  });
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const documentDir = path.dirname(documentPath);
  try {
    const { stdout: rootOut } = await execFileAsync(
      "git",
      ["-C", documentDir, "rev-parse", "--show-toplevel"],
      { env: gitEnv, timeout: GIT_TIMEOUT_MS },
    );
    const root = fs.realpathSync(rootOut.trim());
    const relative = path
      .relative(root, fs.realpathSync(documentPath))
      .split(path.sep)
      .join("/");
    if (relative.startsWith(".."))
      return notFound("the document is not in a git repository.");
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "show", `${ref}:${relative}`],
      { env: gitEnv, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BASELINE_BYTES },
    );
    return {
      ok: true,
      baseline: { source: "git", label: `git ${ref}`, content: stdout },
    };
  } catch {
    return notFound(
      "git has no such ref, or the document does not exist in it.",
    );
  }
}
