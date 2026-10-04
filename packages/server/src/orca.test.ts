import { describe, expect, it } from "vitest";
import {
  closeOrcaTabShowing,
  isSameRoughdraftDocument,
  type OrcaCommandResult,
  openOrcaTab,
  resolveOrcaTarget,
  runOrcaCommand,
} from "./orca";

const WORKTREE_ID = "repo-1::/Users/me/orca/workspaces/app/feature";
const DOC_URL = "http://localhost:7373/?path=%2Frepo%2Fplan.md";

interface RecordedCall {
  command: string;
  args: string[];
}

function orcaJson(result: unknown): OrcaCommandResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ id: "req", ok: true, result }),
    stderr: "",
  };
}

function orcaError(code: string, message = code): OrcaCommandResult {
  return {
    exitCode: 1,
    stdout: JSON.stringify({ id: "req", ok: false, error: { code, message } }),
    stderr: "",
  };
}

/** Answers each `orca` call from a script keyed by its subcommand. */
function scriptedOrca(
  answers: Record<string, Array<OrcaCommandResult | Error>>,
) {
  const calls: RecordedCall[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args });
    const key = args.slice(0, 2).join(" ");
    const next = answers[key]?.shift();
    if (!next) throw new Error(`Unexpected orca call: ${args.join(" ")}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, run };
}

function tab(browserPageId: string, url: string, active = false) {
  return { browserPageId, url, title: "", active, loadError: null };
}

describe("resolveOrcaTarget", () => {
  it("targets the terminal's worktree inside an Orca terminal", () => {
    expect(resolveOrcaTarget({ ORCA_WORKTREE_ID: WORKTREE_ID })).toEqual({
      command: "orca",
      worktree: `id:${WORKTREE_ID}`,
    });
  });

  it("returns null outside Orca", () => {
    expect(resolveOrcaTarget({ TERM_PROGRAM: "iTerm.app" })).toBeNull();
  });

  it("lets ROUGHDRAFT_ORCA=0 keep the regular browser inside Orca", () => {
    expect(
      resolveOrcaTarget({
        ORCA_WORKTREE_ID: WORKTREE_ID,
        ROUGHDRAFT_ORCA: "0",
      }),
    ).toBeNull();
  });

  it("lets ROUGHDRAFT_ORCA=1 use Orca from another terminal", () => {
    expect(resolveOrcaTarget({ ROUGHDRAFT_ORCA: "1" })).toEqual({
      command: "orca",
      worktree: null,
    });
  });

  it("uses the CLI name Orca exports for managed WSL shells", () => {
    expect(
      resolveOrcaTarget({
        ORCA_WORKTREE_ID: WORKTREE_ID,
        ORCA_CLI_COMMAND: "orca-ide",
      }),
    ).toEqual({ command: "orca-ide", worktree: `id:${WORKTREE_ID}` });
  });
});

describe("isSameRoughdraftDocument", () => {
  it("matches the same document on the same server, ignoring view params", () => {
    expect(
      isSameRoughdraftDocument(DOC_URL, `${DOC_URL}&editor=code#section`),
    ).toBe(true);
  });

  it("does not match another document or another server", () => {
    expect(
      isSameRoughdraftDocument(
        DOC_URL,
        "http://localhost:7373/?path=%2Frepo%2Fother.md",
      ),
    ).toBe(false);
    expect(
      isSameRoughdraftDocument(
        DOC_URL,
        "http://localhost:7374/?path=%2Frepo%2Fplan.md",
      ),
    ).toBe(false);
  });

  it("never matches pages that are not documents", () => {
    expect(
      isSameRoughdraftDocument(
        "http://localhost:7373/",
        "http://localhost:7373/",
      ),
    ).toBe(false);
    expect(isSameRoughdraftDocument("about:blank", "about:blank")).toBe(false);
  });
});

describe("openOrcaTab", () => {
  const target = { command: "orca", worktree: `id:${WORKTREE_ID}` };

  it("creates a tab in the worktree and brings it forward", async () => {
    const orca = scriptedOrca({
      "tab list": [orcaJson({ tabs: [] })],
      "tab create": [orcaJson({ browserPageId: "page-1" })],
      "tab switch": [orcaJson({ switched: 0, browserPageId: "page-1" })],
    });

    const result = await openOrcaTab({ target, url: DOC_URL, run: orca.run });

    expect(result).toEqual({
      opened: true,
      reused: false,
      browserPageId: "page-1",
    });
    expect(orca.calls.map((call) => call.args)).toEqual([
      ["tab", "list", "--worktree", `id:${WORKTREE_ID}`, "--json"],
      [
        "tab",
        "create",
        "--url",
        DOC_URL,
        "--worktree",
        `id:${WORKTREE_ID}`,
        "--json",
      ],
      ["tab", "switch", "--page", "page-1", "--focus", "--json"],
    ]);
  });

  it("reuses the tab that already shows the document", async () => {
    const orca = scriptedOrca({
      "tab list": [
        orcaJson({
          tabs: [
            tab("page-other", "http://localhost:7373/?path=%2Frepo%2Fother.md"),
            tab("page-plan", `${DOC_URL}&editor=code`),
          ],
        }),
      ],
      "tab switch": [orcaJson({ switched: 1, browserPageId: "page-plan" })],
    });

    const result = await openOrcaTab({ target, url: DOC_URL, run: orca.run });

    expect(result).toEqual({
      opened: true,
      reused: true,
      browserPageId: "page-plan",
    });
    expect(orca.calls.map((call) => call.args[1])).toEqual(["list", "switch"]);
  });

  it("reloads a reused tab that failed to load", async () => {
    const orca = scriptedOrca({
      "tab list": [
        orcaJson({
          tabs: [{ ...tab("page-plan", DOC_URL), loadError: "refused" }],
        }),
      ],
      "reload --page": [orcaJson({ reloaded: true })],
      "tab switch": [orcaJson({ switched: 0, browserPageId: "page-plan" })],
    });

    const result = await openOrcaTab({ target, url: DOC_URL, run: orca.run });

    expect(result).toMatchObject({ opened: true, reused: true });
    expect(orca.calls.map((call) => call.args.slice(0, 3))).toContainEqual([
      "reload",
      "--page",
      "page-plan",
    ]);
  });

  it("lets Orca pick the worktree from the cwd when there is no worktree id", async () => {
    const orca = scriptedOrca({
      "tab list": [orcaJson({ tabs: [] })],
      "tab create": [orcaJson({ browserPageId: "page-1" })],
      "tab switch": [orcaJson({ switched: 0, browserPageId: "page-1" })],
    });

    await openOrcaTab({
      target: { command: "orca", worktree: null },
      url: DOC_URL,
      run: orca.run,
    });

    for (const call of orca.calls) {
      expect(call.args).not.toContain("--worktree");
    }
  });

  it("still counts the tab as open when only the focus step fails", async () => {
    const orca = scriptedOrca({
      "tab list": [orcaJson({ tabs: [] })],
      "tab create": [orcaJson({ browserPageId: "page-1" })],
      "tab switch": [orcaError("browser_tab_not_found")],
    });

    const result = await openOrcaTab({ target, url: DOC_URL, run: orca.run });

    expect(result).toEqual({
      opened: true,
      reused: false,
      browserPageId: "page-1",
    });
  });

  it("reports why Orca could not be used", async () => {
    const orca = scriptedOrca({
      "tab list": [orcaError("runtime_unavailable", "Orca is not running")],
    });

    const result = await openOrcaTab({ target, url: DOC_URL, run: orca.run });

    expect(result).toEqual({
      opened: false,
      reason: "Orca is not running",
    });
  });

  it("reports a missing orca command", async () => {
    const orca = scriptedOrca({
      "tab list": [
        { exitCode: null, stdout: "", stderr: "", error: "spawn orca ENOENT" },
      ],
    });

    const result = await openOrcaTab({ target, url: DOC_URL, run: orca.run });

    expect(result).toEqual({ opened: false, reason: "spawn orca ENOENT" });
  });

  it("creates the tab without waiting when Orca is slow to list a worktree with no tabs", async () => {
    // Orca waits up to 8 s for saved tabs to load before listing a worktree
    // that has none open; the lookup gives up early instead.
    const listTimeouts: number[] = [];
    const orca = scriptedOrca({
      "tab list": [
        {
          exitCode: null,
          stdout: "",
          stderr: "",
          error: "timed out after 2500 ms",
          timedOut: true,
        },
      ],
      "tab create": [orcaJson({ browserPageId: "page-1" })],
      "tab switch": [orcaJson({ switched: 0, browserPageId: "page-1" })],
    });

    const result = await openOrcaTab({
      target,
      url: DOC_URL,
      run: async (command, args, options) => {
        if (args[1] === "list") listTimeouts.push(options.timeoutMs);
        return orca.run(command, args);
      },
    });

    expect(result).toEqual({
      opened: true,
      reused: false,
      browserPageId: "page-1",
    });
    expect(listTimeouts).toEqual([2_500]);
  });

  it("does not open a second tab when create times out after Orca made one", async () => {
    const orca = scriptedOrca({
      "tab list": [
        orcaJson({ tabs: [] }),
        orcaJson({ tabs: [tab("page-late", DOC_URL)] }),
      ],
      "tab create": [
        { exitCode: null, stdout: "", stderr: "", error: "timed out" },
      ],
      "tab switch": [orcaJson({ switched: 0, browserPageId: "page-late" })],
    });

    const result = await openOrcaTab({ target, url: DOC_URL, run: orca.run });

    expect(result).toEqual({
      opened: true,
      reused: false,
      browserPageId: "page-late",
    });
  });
});

describe("closeOrcaTabShowing", () => {
  it("closes the one tab showing the page, in any worktree", async () => {
    const orca = scriptedOrca({
      "tab list": [
        orcaJson({
          tabs: [
            tab("page-other", "http://localhost:7373/?path=%2Frepo%2Fother.md"),
            tab("page-plan", DOC_URL),
          ],
        }),
      ],
      "tab close": [orcaJson({ closed: true })],
    });

    const result = await closeOrcaTabShowing({
      command: "orca",
      url: DOC_URL,
      run: orca.run,
    });

    expect(result).toEqual({ closed: true });
    expect(orca.calls.map((call) => call.args)).toEqual([
      ["tab", "list", "--worktree", "all", "--json"],
      ["tab", "close", "--page", "page-plan", "--json"],
    ]);
  });

  it("prefers the active tab when the page is open in several tabs", async () => {
    const orca = scriptedOrca({
      "tab list": [
        orcaJson({
          tabs: [tab("page-a", DOC_URL), tab("page-b", DOC_URL, true)],
        }),
      ],
      "tab close": [orcaJson({ closed: true })],
    });

    await closeOrcaTabShowing({ command: "orca", url: DOC_URL, run: orca.run });

    expect(orca.calls.at(-1)?.args).toEqual([
      "tab",
      "close",
      "--page",
      "page-b",
      "--json",
    ]);
  });

  it("closes nothing when it cannot tell which tab asked", async () => {
    const orca = scriptedOrca({
      "tab list": [
        orcaJson({ tabs: [tab("page-a", DOC_URL), tab("page-b", DOC_URL)] }),
      ],
    });

    const result = await closeOrcaTabShowing({
      command: "orca",
      url: DOC_URL,
      run: orca.run,
    });

    expect(result).toEqual({ closed: false, reason: "ambiguous" });
    expect(orca.calls).toHaveLength(1);
  });

  it("closes nothing when no Orca tab shows the page", async () => {
    const orca = scriptedOrca({ "tab list": [orcaJson({ tabs: [] })] });

    const result = await closeOrcaTabShowing({
      command: "orca",
      url: DOC_URL,
      run: orca.run,
    });

    expect(result).toEqual({ closed: false, reason: "not-found" });
  });
});

describe("runOrcaCommand", () => {
  it("captures output and the exit code of a real process", async () => {
    const result = await runOrcaCommand(
      process.execPath,
      ["-e", "process.stdout.write('hi'); process.exit(3)"],
      { timeoutMs: 10_000 },
    );

    expect(result).toEqual({ exitCode: 3, stdout: "hi", stderr: "" });
  });

  it("reports a command that does not exist instead of throwing", async () => {
    const result = await runOrcaCommand(
      "roughdraft-test-no-such-orca-binary",
      ["tab", "list"],
      { timeoutMs: 10_000 },
    );

    expect(result.exitCode).toBeNull();
    expect(result.error).toContain("ENOENT");
  });

  it("stops a command that runs past its timeout", async () => {
    const result = await runOrcaCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60_000)"],
      { timeoutMs: 200 },
    );

    expect(result.exitCode).toBeNull();
    expect(result.error).toBe("timed out after 200 ms");
    expect(result.timedOut).toBe(true);
  });
});
