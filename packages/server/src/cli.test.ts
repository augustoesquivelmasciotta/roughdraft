import fs from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRoughdraftMarkdown } from "@roughdraft/rfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCliDependencies,
  createDefaultOpenUrl,
  ensureServerRunning,
  getServerStateFilePath,
  runCli,
} from "./cli";
import { createApp } from "./index";
import { ROUGHDRAFT_DEFAULT_PORT } from "./network";

interface StartedServer {
  close: () => Promise<void>;
}

async function listenOnLoopbackServers(
  port: number,
  app: ReturnType<typeof createApp>["app"],
): Promise<StartedServer> {
  const servers: Server[] = [];

  for (const host of ["127.0.0.1", "::1"]) {
    const server = createHttpServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") {
            resolve();
            return;
          }

          reject(error);
        });

        server.listen(port, host, () => resolve());
      });
      if (server.listening) {
        servers.push(server);
      }
    } catch (error) {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      throw error;
    }
  }

  return {
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections?.();
              server.close((error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
        ),
      );
    },
  };
}

describe("cli", () => {
  let tempDir: string;
  let stateDir: string;
  let projectDir: string;
  let devFrontendStateFile: string;
  let nextPid: number;
  let runningPids: Set<number>;
  let serverByPid: Map<number, StartedServer>;
  let portByPid: Map<number, number>;
  const serverRoot = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-"));
    stateDir = path.join(tempDir, "state");
    projectDir = path.join(tempDir, "project");
    devFrontendStateFile = path.join(tempDir, "dev-frontend.json");
    fs.mkdirSync(projectDir, { recursive: true });
    nextPid = 1000;
    runningPids = new Set<number>();
    serverByPid = new Map<number, StartedServer>();
    portByPid = new Map<number, number>();
  });

  function expectedOpenUrl(baseUrl: string, documentPath: string): string {
    const url = new URL(baseUrl);
    url.pathname = "/";
    url.searchParams.set("path", documentPath);
    return url.toString();
  }

  function parseOnlyJsonLog<T>(logs: string[]): T {
    expect(logs).toHaveLength(1);
    return JSON.parse(logs[0] ?? "{}") as T;
  }

  function extractHelpExample(
    logs: string[],
    startLine: string,
    stopLine: string,
  ): string {
    const startIndex = logs.indexOf(startLine);
    const stopIndex = logs.indexOf(stopLine);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(startIndex);

    return `${logs
      .slice(startIndex + 1, stopIndex)
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")}\n`;
  }

  async function noUpdateStatus() {
    return {
      packageName: "roughdraft",
      currentVersion: "0.1.0",
      latestVersion: "0.1.0",
      updateAvailable: false,
      updateCommand: "npm i -g roughdraft@latest",
    };
  }

  afterEach(async () => {
    await Promise.all(
      Array.from(serverByPid.values(), (server) => server.close()),
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestDependencies() {
    const logs: string[] = [];
    const errors: string[] = [];
    let lastOpenedUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        const port = Number.parseInt(url.port || "80", 10);
        const hasActiveServer = Array.from(portByPid.entries()).some(
          ([pid, activePort]) => runningPids.has(pid) && activePort === port,
        );

        if (url.pathname === "/api/status" && !hasActiveServer) {
          throw new Error("connect ECONNREFUSED");
        }

        return fetch(input, init);
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      resolveUpdateStatus: noUpdateStatus,
      spawnServerProcess: async ({ port, projectDir: nextProjectDir }) => {
        spawnCount += 1;
        const pid = nextPid;
        nextPid += 1;
        const { app } = createApp({
          port,
          projectDir: nextProjectDir,
          serverRoot,
          staticDirPath: nextProjectDir,
        });
        const started = await listenOnLoopbackServers(port, app);
        runningPids.add(pid);
        serverByPid.set(pid, started);
        portByPid.set(pid, port);
        return { pid };
      },
      isProcessRunning: (pid) => runningPids.has(pid),
      stopProcess: async (pid) => {
        const server = serverByPid.get(pid);
        if (server) {
          await server.close();
        }
        serverByPid.delete(pid);
        portByPid.delete(pid);
        runningPids.delete(pid);
      },
    });

    return {
      deps,
      logs,
      errors,
      getLastOpenedUrl: () => lastOpenedUrl,
      getSpawnCount: () => spawnCount,
    };
  }

  it("writes server state and reuses a running background server", async () => {
    const test = createTestDependencies();

    const first = await ensureServerRunning(test.deps, { projectDir });
    const second = await ensureServerRunning(test.deps, { projectDir });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.server.url).toBe(`http://localhost:${first.server.port}`);
    expect(test.getSpawnCount()).toBe(1);

    const stateFilePath = getServerStateFilePath(test.deps.env);
    const persisted = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as {
      port: number;
      pid: number;
      startedAt: string;
      url: string;
    };

    expect(persisted).toMatchObject({
      port: first.server.port,
      pid: first.server.pid,
      url: first.server.url,
    });
    expect(typeof persisted.startedAt).toBe("string");
  });

  it("auto-starts from open and opens the requested markdown file URL", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.getLastOpenedUrl()).toBe(
      expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
    );
    expect(fs.existsSync(getServerStateFilePath(test.deps.env))).toBeTruthy();
  });

  it("prints an update notice after a successful human-readable command", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath, "--no-watch"], {
      ...test.deps,
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0.1.1",
        latestVersion: "0.1.3",
        updateAvailable: true,
        updateCommand: "npm i -g roughdraft@latest",
      }),
    });

    expect(exitCode).toBe(0);
    expect(test.logs.at(-1)).toBe(
      "Roughdraft update available: 0.1.1 -> 0.1.3. Run `npm i -g roughdraft@latest` to update.",
    );
  });

  it("does not add an update notice to JSON command output", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch", "--json"],
      {
        ...test.deps,
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.1",
          latestVersion: "0.1.3",
          updateAvailable: true,
          updateCommand: "npm i -g roughdraft@latest",
        }),
      },
    );
    const payload = parseOnlyJsonLog<{ opened: boolean }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload.opened).toBe(true);
  });

  it("keeps the original command result when the update check fails", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["open", documentPath, "--no-watch"], {
      ...test.deps,
      resolveUpdateStatus: async () => {
        throw new Error("registry unavailable");
      },
    });

    expect(exitCode).toBe(0);
    expect(test.logs).not.toContain("registry unavailable");
  });

  it("reuses a connected document window before opening another browser window", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    let postedOpenRequest: { path?: string; url?: string } | null = null;
    let lastOpenedUrl: string | null = null;
    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.pathname === "/api/open-request" && init?.method === "POST") {
          postedOpenRequest = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ delivered: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "browser";
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(postedOpenRequest).toEqual({
      path: documentPath,
      url: expectedOpenUrl(
        `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
        documentPath,
      ),
    });
    expect(lastOpenedUrl).toBeNull();
  });

  describe("inside an Orca terminal", () => {
    const worktreeId = "repo-1::/Users/me/orca/workspaces/app/feature";

    /**
     * Stands in for the `orca` CLI: records every call and answers like
     * Orca 1.4 does. `tabs` is read on each `tab list` so a test can describe
     * tabs that depend on the server port chosen at run time.
     */
    function fakeOrca(
      tabs: () => Array<{ browserPageId: string; url: string }> = () => [],
      options: { unavailable?: string } = {},
    ) {
      const calls: string[][] = [];
      const reply = (result: unknown) => ({
        exitCode: 0,
        stdout: JSON.stringify({ id: "req", ok: true, result }),
        stderr: "",
      });
      const runOrcaCommand = async (_command: string, args: string[]) => {
        calls.push(args);
        if (options.unavailable) {
          return {
            exitCode: 1,
            stdout: JSON.stringify({
              id: "req",
              ok: false,
              error: {
                code: "runtime_unavailable",
                message: options.unavailable,
              },
            }),
            stderr: "",
          };
        }
        const command = args.slice(0, 2).join(" ");
        if (command === "tab list") {
          return reply({
            tabs: tabs().map((tab) => ({
              ...tab,
              title: "",
              active: false,
              loadError: null,
            })),
          });
        }
        if (command === "tab create") {
          return reply({ browserPageId: "page-new" });
        }
        if (command === "tab switch") {
          return reply({ switched: 0, browserPageId: args[3] });
        }
        throw new Error(`Unexpected orca call: ${args.join(" ")}`);
      };
      return { calls, runOrcaCommand };
    }

    function readPersistedPort(env: NodeJS.ProcessEnv) {
      return (
        JSON.parse(fs.readFileSync(getServerStateFilePath(env), "utf8")) as {
          port: number;
        }
      ).port;
    }

    it("opens the document in a tab of the terminal's worktree and brings it forward", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const orca = fakeOrca();
      let openRequestPosted = false;

      const exitCode = await runCli(
        ["open", documentPath, "--no-watch", "--json"],
        {
          ...test.deps,
          env: { ...test.deps.env, ORCA_WORKTREE_ID: worktreeId },
          runOrcaCommand: orca.runOrcaCommand,
          fetchImpl: async (input, init) => {
            if (String(input).includes("/api/open-request")) {
              openRequestPosted = true;
            }
            return test.deps.fetchImpl(input, init);
          },
        },
      );
      const payload = parseOnlyJsonLog<{ url: string; openMode: string }>(
        test.logs,
      );

      expect(exitCode).toBe(0);
      expect(payload.openMode).toBe("orca-tab");
      expect(payload.url).toBe(
        expectedOpenUrl(
          `http://localhost:${readPersistedPort(test.deps.env)}`,
          documentPath,
        ),
      );
      expect(orca.calls).toEqual([
        ["tab", "list", "--worktree", `id:${worktreeId}`, "--json"],
        [
          "tab",
          "create",
          "--url",
          payload.url,
          "--worktree",
          `id:${worktreeId}`,
          "--json",
        ],
        ["tab", "switch", "--page", "page-new", "--focus", "--json"],
      ]);
      // The Orca tab replaces both the browser window and the reuse of a
      // window that may be open somewhere else.
      expect(test.getLastOpenedUrl()).toBeNull();
      expect(openRequestPosted).toBe(false);
    });

    it("brings back the tab already showing the document instead of opening another", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const orca = fakeOrca(() => [
        {
          browserPageId: "page-draft",
          url: `${expectedOpenUrl(
            `http://localhost:${readPersistedPort(test.deps.env)}`,
            documentPath,
          )}&editor=code`,
        },
      ]);

      const exitCode = await runCli(["open", documentPath, "--no-watch"], {
        ...test.deps,
        env: { ...test.deps.env, ORCA_WORKTREE_ID: worktreeId },
        runOrcaCommand: orca.runOrcaCommand,
      });

      expect(exitCode).toBe(0);
      expect(orca.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
        "tab list",
        "tab switch",
      ]);
      expect(orca.calls[1]).toContain("page-draft");
      expect(test.logs).toContain(
        `Reused the Roughdraft tab in Orca: ${expectedOpenUrl(
          `http://localhost:${readPersistedPort(test.deps.env)}`,
          documentPath,
        )}`,
      );
    });

    it("tells a reused Orca tab about the new session label without navigating it", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      await ensureServerRunning(test.deps, { projectDir });
      const port = readPersistedPort(test.deps.env);
      const pageUrl = expectedOpenUrl(`http://localhost:${port}`, documentPath);
      const orca = fakeOrca(() => [
        { browserPageId: "page-draft", url: `${pageUrl}&label=plan-review` },
      ]);
      // The tab that Orca shows polls for open requests.
      const poll = () =>
        fetch(
          `http://127.0.0.1:${port}/api/open-requests/poll?${new URLSearchParams(
            { clientId: "orca-tab", path: documentPath, label: "plan-review" },
          )}`,
        ).then((response) => response.json() as Promise<{ requests: unknown }>);
      await poll();

      const exitCode = await runCli(
        ["open", documentPath, "--no-watch", "--label", "spec-edit"],
        {
          ...test.deps,
          env: { ...test.deps.env, ORCA_WORKTREE_ID: worktreeId },
          runOrcaCommand: orca.runOrcaCommand,
        },
      );

      expect(exitCode).toBe(0);
      expect(orca.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
        "tab list",
        "tab switch",
      ]);
      expect(await poll()).toEqual({
        requests: [
          {
            path: documentPath,
            url: `${pageUrl}&label=spec-edit`,
            label: "spec-edit",
          },
        ],
      });
      expect(test.errors).toContain(
        `${documentPath} is already open in a tab opened by plan-review. This open reuses that tab; Done Reviewing there reaches every session waiting on the file.`,
      );
    });

    it("falls back to the browser and says why when Orca cannot open a tab", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const orca = fakeOrca(undefined, { unavailable: "Orca is not running" });

      const exitCode = await runCli(["open", documentPath, "--no-watch"], {
        ...test.deps,
        env: { ...test.deps.env, ORCA_WORKTREE_ID: worktreeId },
        runOrcaCommand: orca.runOrcaCommand,
      });

      expect(exitCode).toBe(0);
      expect(test.errors).toEqual([
        "Could not open an Orca tab (Orca is not running). Opening the browser instead.",
      ]);
      expect(test.getLastOpenedUrl()).toContain(
        encodeURIComponent(documentPath),
      );
    });

    it("fails without opening a browser when ROUGHDRAFT_ORCA=1 and Orca cannot open the tab", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const orca = fakeOrca(undefined, { unavailable: "Orca is not running" });

      const exitCode = await runCli(["open", documentPath, "--no-watch"], {
        ...test.deps,
        env: { ...test.deps.env, ROUGHDRAFT_ORCA: "1" },
        runOrcaCommand: orca.runOrcaCommand,
      });

      expect(exitCode).toBe(1);
      expect(test.errors).toEqual([
        "Could not open an Orca tab (Orca is not running).",
      ]);
      expect(test.getLastOpenedUrl()).toBeNull();
    });

    it("keeps the regular browser when ROUGHDRAFT_ORCA=0", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const orca = fakeOrca();

      await runCli(["open", documentPath, "--no-watch"], {
        ...test.deps,
        env: {
          ...test.deps.env,
          ORCA_WORKTREE_ID: worktreeId,
          ROUGHDRAFT_ORCA: "0",
        },
        runOrcaCommand: orca.runOrcaCommand,
      });

      expect(orca.calls).toEqual([]);
      expect(test.getLastOpenedUrl()).not.toBeNull();
    });

    it("does not touch Orca when nothing should open", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const orca = fakeOrca();
      const deps = {
        ...test.deps,
        env: { ...test.deps.env, ORCA_WORKTREE_ID: worktreeId },
        runOrcaCommand: orca.runOrcaCommand,
      };

      await runCli(["open", documentPath, "--print-url"], deps);
      await runCli(["open", documentPath, "--no-open", "--no-watch"], deps);

      expect(orca.calls).toEqual([]);
    });

    it("reports the Orca tab target from doctor --json", async () => {
      const test = createTestDependencies();

      await runCli(["doctor", "--json"], {
        ...test.deps,
        env: { ...test.deps.env, ORCA_WORKTREE_ID: worktreeId },
      });
      const payload = parseOnlyJsonLog<{ orcaTabs: unknown }>(test.logs);

      expect(payload.orcaTabs).toEqual({
        command: "orca",
        worktree: `id:${worktreeId}`,
      });
    });
  });

  it("opens the default browser on macOS when Chrome is installed but not the default browser", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "darwin",
      spawnSyncCommand: (command, args) => {
        if (command === "plutil") {
          expect(args?.join(" ")).toContain(
            "com.apple.launchservices.secure.plist",
          );
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                LSHandlerURLScheme: "http",
                LSHandlerRoleAll: "com.apple.Safari",
              },
            ]),
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        if (command === "open" && args?.[0] === "-Ra") {
          return {
            status: 0,
            stdout: "",
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        throw new Error(`unexpected spawnSync command ${command}`);
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("browser");
    expect(opened).toEqual([
      { command: "open", args: ["http://localhost:4020/?file=draft.md"] },
    ]);
  });

  it("opens a Chrome app window on macOS when Chrome is the default browser", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "darwin",
      spawnSyncCommand: (command, args) => {
        if (command === "plutil") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                LSHandlerURLScheme: "http",
                LSHandlerRoleAll: "com.google.Chrome",
              },
            ]),
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        if (command === "open" && args?.[0] === "-Ra") {
          return {
            status: 0,
            stdout: "",
          } as ReturnType<typeof import("node:child_process").spawnSync>;
        }

        throw new Error(`unexpected spawnSync command ${command}`);
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("chrome-app");
    expect(opened).toEqual([
      {
        command: "open",
        args: [
          "-na",
          "Google Chrome",
          "--args",
          "--app=http://localhost:4020/?file=draft.md",
        ],
      },
    ]);
  });

  it("opens the default browser on Windows without macOS browser detection", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "win32",
      spawnSyncCommand: () => {
        throw new Error("macOS browser detection should not run on Windows");
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("browser");
    expect(opened).toEqual([
      {
        command: "cmd",
        args: ["/c", "start", "", "http://localhost:4020/?file=draft.md"],
      },
    ]);
  });

  it("opens the default browser on Linux without macOS browser detection", () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const openUrl = createDefaultOpenUrl({
      env: {},
      platform: "linux",
      spawnSyncCommand: () => {
        throw new Error("macOS browser detection should not run on Linux");
      },
      openDetachedCommand: (command, args) => {
        opened.push({ command, args });
      },
    });

    const mode = openUrl("http://localhost:4020/?file=draft.md");

    expect(mode).toBe("browser");
    expect(opened).toEqual([
      {
        command: "xdg-open",
        args: ["http://localhost:4020/?file=draft.md"],
      },
    ]);
  });

  describe("open --label", () => {
    it("carries the label in the document URL", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");

      const exitCode = await runCli(
        ["open", documentPath, "--print-url", "--label", "plan-review"],
        test.deps,
      );

      expect(exitCode).toBe(0);
      const printed = new URL(test.logs.at(-1) ?? "");
      expect(printed.searchParams.get("path")).toBe(documentPath);
      expect(printed.searchParams.get("label")).toBe("plan-review");
    });

    it("accepts --label=<text> and leaves the URL without a label when blank", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");

      await runCli(
        ["open", documentPath, "--print-url", "--label=spec-edit"],
        test.deps,
      );
      await runCli(
        ["open", documentPath, "--print-url", "--label", "  "],
        test.deps,
      );

      expect(new URL(test.logs.at(-2) ?? "").searchParams.get("label")).toBe(
        "spec-edit",
      );
      expect(new URL(test.logs.at(-1) ?? "").searchParams.has("label")).toBe(
        false,
      );
    });

    it("sends the label with the open request to a tab showing the document", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      const poll = (label: string) =>
        fetch(
          `http://127.0.0.1:${result.server.port}/api/open-requests/poll?${new URLSearchParams(
            { clientId: "tab-1", path: documentPath, label },
          )}`,
        ).then((response) => response.json() as Promise<{ requests: unknown }>);
      await poll("plan-review");

      const exitCode = await runCli(
        ["open", documentPath, "--no-watch", "--label", "plan-review"],
        test.deps,
      );

      expect(exitCode).toBe(0);
      expect(test.getLastOpenedUrl()).toBeNull();
      expect(await poll("plan-review")).toEqual({
        requests: [
          {
            path: documentPath,
            url: `${expectedOpenUrl(result.server.url, documentPath)}&label=plan-review`,
            label: "plan-review",
          },
        ],
      });
      // The same session reopening for its next round is not a takeover.
      expect(test.errors).toEqual([]);
    });

    it("warns before reusing a tab another session opened", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      await fetch(
        `http://127.0.0.1:${result.server.port}/api/open-requests/poll?${new URLSearchParams(
          { clientId: "tab-1", path: documentPath, label: "plan-review" },
        )}`,
      );

      await runCli(["open", documentPath, "--no-watch"], test.deps);

      expect(test.errors).toEqual([
        `${documentPath} is already open in a tab opened by plan-review. This open reuses that tab; Done Reviewing there reaches every session waiting on the file.`,
      ]);
    });

    it("names the label in status once the tab reports it", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      await fetch(
        `http://127.0.0.1:${result.server.port}/api/open-requests/poll?${new URLSearchParams(
          { clientId: "tab-1", path: documentPath, label: "plan-review" },
        )}`,
      );

      await runCli(["status"], test.deps);

      expect(test.logs).toContain("Session: plan-review");
    });

    it("rejects --label outside open", async () => {
      const test = createTestDependencies();

      expect(await runCli(["status", "--label", "x"], test.deps)).toBe(2);
      expect(test.errors).toEqual(["Unknown flag: --label"]);
    });
  });

  it("prints only the document URL from open --print-url", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--print-url"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.logs).toEqual([
      expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
    ]);
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("emits JSON from open --no-watch --json without scraping human prose", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(
      ["open", documentPath, "--no-watch", "--json"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };
    const payload = parseOnlyJsonLog<{
      opened: boolean;
      url: string;
      serverUrl: string;
      path: string;
      openMode: string;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      opened: true,
      url: expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
      serverUrl: `http://localhost:${persisted.port}`,
      path: documentPath,
      openMode: "disabled",
    });
  });

  it("prefers the live dev frontend URL when it matches this checkout", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    let lastOpenedUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname === "/api/status" && url.port === "5173") {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return fetch(input, init);
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: (pid) => runningPids.has(pid),
      stopProcess: async (pid) => {
        const server = serverByPid.get(pid);
        if (server) {
          await server.close();
        }
        serverByPid.delete(pid);
        portByPid.delete(pid);
        runningPids.delete(pid);
      },
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(lastOpenedUrl).toBe(
      expectedOpenUrl("http://localhost:5173", documentPath),
    );
  });

  it("posts the default open watcher to the dev API behind the live frontend", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    let lastOpenedUrl: string | null = null;
    let watchUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input, _init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname === "/api/status" && url.port === "5173") {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: 3000,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.pathname === "/api/review-events/watch") {
          watchUrl = url.toString();
          return new Response(
            JSON.stringify({
              events: [{ documentPath, type: "review.completed" }],
              timedOut: false,
              nextSequence: 2,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected request: ${url.toString()}`);
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      log: () => {},
      error: () => {},
      resolveUpdateStatus: noUpdateStatus,
    });

    const exitCode = await runCli(
      ["open", documentPath, "--json", "--batch-window", "0"],
      deps,
    );

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(lastOpenedUrl).toBe(
      expectedOpenUrl("http://localhost:5173", documentPath),
    );
    expect(watchUrl).toBe("http://localhost:3000/api/review-events/watch");
  });

  it("falls back to the api server URL when the dev frontend hint is stale", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: 3000,
          appPort: 5173,
          mode: "full-dev",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5173",
        },
        null,
        2,
      )}\n`,
    );

    const test = createTestDependencies();
    const exitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      test.deps,
    );
    const persisted = JSON.parse(
      fs.readFileSync(getServerStateFilePath(test.deps.env), "utf8"),
    ) as { port: number };

    expect(exitCode).toBe(0);
    expect(test.getSpawnCount()).toBe(1);
    expect(test.getLastOpenedUrl()).toBe(
      expectedOpenUrl(`http://localhost:${persisted.port}`, documentPath),
    );
  });

  it("uses the preview-web frontend URL when that workflow is active", async () => {
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      devFrontendStateFile,
      `${JSON.stringify(
        {
          apiPort: null,
          appPort: 5174,
          mode: "preview-web",
          repoRoot: serverRoot,
          startedAt: new Date().toISOString(),
          url: "http://localhost:5174",
        },
        null,
        2,
      )}\n`,
    );

    let lastOpenedUrl: string | null = null;
    let spawnCount = 0;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
        ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: devFrontendStateFile,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.href === "http://localhost:5174/") {
          return new Response("<!doctype html><html></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }

        throw new Error("connect ECONNREFUSED");
      },
      spawnServerProcess: async () => {
        spawnCount += 1;
        throw new Error("should not spawn");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      openUrl: (url) => {
        lastOpenedUrl = url;
        return "disabled";
      },
      log: () => {},
      error: () => {},
    });

    const exitCode = await runCli(["open", documentPath, "--no-watch"], deps);

    expect(exitCode).toBe(0);
    expect(spawnCount).toBe(0);
    expect(lastOpenedUrl).toBe(
      expectedOpenUrl("http://localhost:5174", documentPath),
    );
  });

  it("rejects missing markdown files before opening", async () => {
    const test = createTestDependencies();
    const missingPath = path.join(projectDir, "missing.md");

    const exitCode = await runCli(["open", missingPath], test.deps);

    expect(exitCode).toBe(1);
    expect(test.getSpawnCount()).toBe(0);
    expect(test.errors).toContain(`Path not found: ${missingPath}`);
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("stops the running server and removes persisted state", async () => {
    const test = createTestDependencies();

    await ensureServerRunning(test.deps, { projectDir });
    const stopExitCode = await runCli(["stop"], test.deps);
    const statusExitCode = await runCli(["status"], test.deps);

    expect(stopExitCode).toBe(0);
    expect(statusExitCode).toBe(1);
    expect(fs.existsSync(getServerStateFilePath(test.deps.env))).toBeFalsy();
    expect(test.logs).toContain(
      "Roughdraft is not running. Start it with `roughdraft start`.",
    );
  });

  it("returns successful JSON status when Roughdraft is not running", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["status", "--json"], test.deps);
    const payload = parseOnlyJsonLog<{
      running: boolean;
      stateFile: string;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      running: false,
      stateFile: getServerStateFilePath(test.deps.env),
    });
  });

  it("emits JSON from status when Roughdraft is running", async () => {
    const test = createTestDependencies();
    const result = await ensureServerRunning(test.deps, { projectDir });

    const exitCode = await runCli(["status", "--json"], test.deps);
    const payload = parseOnlyJsonLog<{
      running: boolean;
      url: string;
      port: number;
      pid: number;
      startedAt: string;
      stateFile: string;
      managed: boolean;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload).toEqual({
      running: true,
      url: result.server.url,
      port: result.server.port,
      pid: result.server.pid,
      startedAt: result.server.startedAt,
      stateFile: getServerStateFilePath(test.deps.env),
      managed: true,
      documents: [],
    });
  });

  describe("status naming the document", () => {
    const reviewedMarkdown = [
      "# Draft",
      "",
      'Intro {>>Needs a source<<}{id="c1" by="user" at="2026-09-06T00:00:00Z"}',
      '{>>Added one<<}{id="r1" by="AI" at="2026-09-06T00:01:00Z" re="c1"}',
      'Old {>>Fixed<<}{id="c2" by="user" at="2026-09-06T00:00:00Z" status="resolved"}',
      '{++new text++}{id="s1" by="user" at="2026-09-06T00:00:00Z"}',
      "",
    ].join("\n");

    // Stands in for a browser tab: the app polls /api/open-requests/poll with
    // the path it has open (and, since #15, the label it was opened with).
    async function pollAsTab(
      port: number,
      documentPath: string | null,
      clientId: string,
      sessionLabel?: string,
    ) {
      const url = new URL(`http://127.0.0.1:${port}/api/open-requests/poll`);
      url.searchParams.set("clientId", clientId);
      if (documentPath) url.searchParams.set("path", documentPath);
      if (sessionLabel) url.searchParams.set("label", sessionLabel);
      const response = await fetch(url);
      expect(response.status).toBe(200);
    }

    async function saveThroughTab(
      port: number,
      documentPath: string,
      content: string,
    ) {
      const query = new URLSearchParams({
        projectPath: path.dirname(documentPath),
        path: path.basename(documentPath),
      });
      const response = await fetch(
        `http://127.0.0.1:${port}/api/markdown-file?${query}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      expect(response.status).toBe(200);
    }

    it("names each open document and says when no label was given", async () => {
      const test = createTestDependencies();
      const draftPath = path.join(projectDir, "draft.md");
      const otherPath = path.join(projectDir, "other.md");
      fs.writeFileSync(draftPath, "# Draft\n");
      fs.writeFileSync(otherPath, "# Other\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      await pollAsTab(result.server.port, draftPath, "tab-1");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pollAsTab(result.server.port, otherPath, "tab-2");
      await pollAsTab(result.server.port, null, "home");

      const exitCode = await runCli(["status"], test.deps);

      expect(exitCode).toBe(0);
      expect(test.logs).toEqual([
        `Roughdraft is running at ${result.server.url}`,
        `PID: ${result.server.pid}`,
        `Started: ${result.server.startedAt}`,
        `State file: ${getServerStateFilePath(test.deps.env)}`,
        `Document: ${draftPath}`,
        "Session: no label given",
        `Document: ${otherPath}`,
        "Session: no label given",
      ]);
    });

    it("says no document is open when no tab has one", async () => {
      const test = createTestDependencies();
      await ensureServerRunning(test.deps, { projectDir });

      const exitCode = await runCli(["status"], test.deps);

      expect(exitCode).toBe(0);
      expect(test.logs).toContain("Document: none open");
    });

    it("carries the open documents in status --json", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      await pollAsTab(result.server.port, documentPath, "tab-1");

      const exitCode = await runCli(["status", "--json"], test.deps);
      const payload = parseOnlyJsonLog<{ documents: unknown[] }>(test.logs);

      expect(exitCode).toBe(0);
      expect(payload.documents).toEqual([
        {
          path: documentPath,
          sessionLabel: null,
          openedAt: expect.any(String),
          lastSavedAt: null,
        },
      ]);
    });

    it("reports a document's open thread ids and its last save", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      await pollAsTab(result.server.port, documentPath, "tab-1");
      await saveThroughTab(result.server.port, documentPath, reviewedMarkdown);

      const exitCode = await runCli(["status", "draft.md"], test.deps);

      expect(exitCode).toBe(0);
      expect(test.logs).toContain(`Document: ${documentPath}`);
      expect(test.logs).toContain("Session: no label given");
      expect(test.logs).toContain("Open threads: 3 (c1, r1, s1)");
      const lastSave = test.logs.find((line) => line.startsWith("Last save: "));
      expect(lastSave).toMatch(/^Last save: \d{4}-\d\d-\d\dT/);
    });

    it("reports the same facts under document in status <path> --json", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, reviewedMarkdown);
      const result = await ensureServerRunning(test.deps, { projectDir });
      await pollAsTab(result.server.port, documentPath, "tab-1");

      const exitCode = await runCli(
        ["status", documentPath, "--json"],
        test.deps,
      );
      const payload = parseOnlyJsonLog<{ document: unknown }>(test.logs);

      expect(exitCode).toBe(0);
      expect(payload.document).toEqual({
        path: documentPath,
        open: true,
        sessionLabel: null,
        openedAt: expect.any(String),
        lastSavedAt: null,
        tabs: [{ sessionLabel: null, openedAt: expect.any(String) }],
        openThreads: { count: 3, ids: ["c1", "r1", "s1"] },
        threadsError: null,
      });
    });

    it("counts a reply under a resolved comment as open, like the review loop", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(
        documentPath,
        [
          "# Draft",
          "",
          'Intro {>>Needs a source<<}{id="c1" by="user" at="2026-09-06T00:00:00Z" status="resolved"}',
          '{>>Still waiting<<}{id="r1" by="AI" at="2026-09-06T00:01:00Z" re="c1"}',
          "",
        ].join("\n"),
      );
      const result = await ensureServerRunning(test.deps, { projectDir });
      await pollAsTab(result.server.port, documentPath, "tab-1");

      await runCli(["status", documentPath], test.deps);

      expect(test.logs).toContain("Open threads: 1 (r1)");
    });

    it("says a path is not open and exits 1, or exits 0 with open false in --json", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      await ensureServerRunning(test.deps, { projectDir });

      expect(await runCli(["status", documentPath], test.deps)).toBe(1);
      expect(test.logs).toContain(`${documentPath} is not open in Roughdraft.`);

      test.logs.length = 0;
      expect(await runCli(["status", documentPath, "--json"], test.deps)).toBe(
        0,
      );
      expect(
        parseOnlyJsonLog<{ document: unknown }>(test.logs).document,
      ).toEqual({ path: documentPath, open: false });
    });

    it("lists every tab that holds the same path, newest last", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");
      const result = await ensureServerRunning(test.deps, { projectDir });
      await pollAsTab(result.server.port, documentPath, "tab-1");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pollAsTab(result.server.port, documentPath, "tab-2");

      await runCli(["status", documentPath], test.deps);

      expect(
        test.logs.some((line) =>
          /^Also open in: no label given \(opened .+\)$/.test(line),
        ),
      ).toBe(true);
    });

    it("reports a document as not open when Roughdraft is not running", async () => {
      const test = createTestDependencies();

      const exitCode = await runCli(
        ["status", "draft.md", "--json"],
        test.deps,
      );

      expect(exitCode).toBe(0);
      expect(
        parseOnlyJsonLog<{ running: boolean; document: unknown }>(test.logs),
      ).toMatchObject({
        running: false,
        document: { path: path.join(projectDir, "draft.md"), open: false },
      });
    });

    it("rejects more than one path", async () => {
      const test = createTestDependencies();

      expect(await runCli(["status", "a.md", "b.md"], test.deps)).toBe(2);
      expect(test.errors).toEqual([
        "Usage: roughdraft status [<path>] [--json]",
      ]);
    });
  });

  it("prints watch and mcp in top-level help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs.join("\n")).toContain("watch <path>");
    expect(test.logs.join("\n")).toContain("mcp");
  });

  it("waits for a review completed event from watch --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const watchPromise = runCli(
      [
        "watch",
        documentPath,
        "--json",
        "--timeout",
        "2",
        "--batch-window",
        "0",
      ],
      test.deps,
    );

    let persisted: { port: number } | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stateFile = getServerStateFilePath(test.deps.env);
      if (fs.existsSync(stateFile)) {
        persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
          port: number;
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(persisted).not.toBeNull();
    await fetch(`http://localhost:${persisted?.port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "draft.md",
        overallComment: "Please prioritize the CLI contract.",
      }),
    });

    const exitCode = await watchPromise;
    const payload = parseOnlyJsonLog<{
      timedOut: boolean;
      events: Array<{
        documentPath: string;
        overallComment?: string;
        type: string;
      }>;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(payload.timedOut).toBe(false);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      documentPath,
      overallComment: "Please prioritize the CLI contract.",
      type: "review.completed",
    });
  });

  it("opens a document and waits for the next review event by default from open --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");
    let watchRequestBody: {
      timeoutSeconds?: number;
      batchWindowSeconds?: number;
    } | null = null;
    const deps = {
      ...test.deps,
      fetchImpl: async (input: Parameters<typeof fetch>[0], init) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );
        if (
          url.pathname === "/api/review-events/watch" &&
          typeof init?.body === "string"
        ) {
          watchRequestBody = JSON.parse(init.body) as {
            timeoutSeconds?: number;
            batchWindowSeconds?: number;
          };
        }
        return test.deps.fetchImpl(input, init);
      },
    };

    const watchPromise = runCli(
      ["open", documentPath, "--json", "--batch-window", "0"],
      deps,
    );

    let persisted: { port: number } | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stateFile = getServerStateFilePath(test.deps.env);
      if (fs.existsSync(stateFile)) {
        persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
          port: number;
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(persisted).not.toBeNull();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (watchRequestBody) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(watchRequestBody).toMatchObject({
      batchWindowSeconds: 0,
    });
    // Without --timeout the CLI still waits indefinitely, but in bounded
    // polls that stay below undici's five-minute headers timeout.
    expect(watchRequestBody?.timeoutSeconds).toBeGreaterThan(0);
    expect(watchRequestBody?.timeoutSeconds).toBeLessThanOrEqual(240);
    await fetch(`http://localhost:${persisted?.port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
    });

    const exitCode = await watchPromise;
    const payload = parseOnlyJsonLog<{
      timedOut: boolean;
      events: Array<{ documentPath: string; type: string }>;
    }>(test.logs);

    expect(exitCode).toBe(0);
    expect(test.getLastOpenedUrl()).toContain(encodeURIComponent(documentPath));
    expect(payload).toMatchObject({
      timedOut: false,
      events: [
        {
          documentPath,
          type: "review.completed",
        },
      ],
    });
  });

  // Resolves once the CLI's watch is registered on the server, not merely once
  // the server is up: a Done Reviewing posted before the priming watch poll is
  // excluded by its fromNow cursor, and the open would then wait forever.
  async function waitForPersistedPort(
    env: NodeJS.ProcessEnv,
    documentName = "draft.md",
  ): Promise<number> {
    let port: number | null = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const stateFile = getServerStateFilePath(env);
      if (port === null && fs.existsSync(stateFile)) {
        port = (
          JSON.parse(fs.readFileSync(stateFile, "utf8")) as { port: number }
        ).port;
      }
      if (port !== null) {
        const params = new URLSearchParams({
          projectPath: projectDir,
          path: documentName,
        });
        const status = (await (
          await fetch(
            `http://localhost:${port}/api/review-events/status?${params.toString()}`,
          )
        ).json()) as { watching?: boolean };
        if (status.watching) return port;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the CLI never registered a review watcher");
  }

  async function submitDoneReviewing(
    port: number,
    body: { overallComment?: string },
  ) {
    const response = await fetch(`http://localhost:${port}/api/review-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectDir,
        path: "draft.md",
        ...body,
      }),
    });
    expect(response.status).toBe(201);
  }

  interface LoopPayload {
    timedOut: boolean;
    done: boolean;
    doneReason: string | null;
    events: Array<{ done: boolean; doneReason: string | null }>;
  }

  const OPEN_THREAD_DRAFT = [
    "# Draft",
    "",
    'Needs {==support==}{>>Add a source<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
    "",
  ].join("\n");

  describe("open --loop", () => {
    it("reports done when the overall comment says done", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);

      const openPromise = runCli(
        ["open", documentPath, "--loop", "--json", "--batch-window", "0"],
        test.deps,
      );
      const port = await waitForPersistedPort(test.deps.env);
      await submitDoneReviewing(port, { overallComment: "Done, thanks!" });

      const exitCode = await openPromise;
      const payload = parseOnlyJsonLog<LoopPayload>(test.logs);

      expect(exitCode).toBe(0);
      expect(payload).toMatchObject({
        timedOut: false,
        done: true,
        doneReason: "overall-comment",
        events: [{ done: true, doneReason: "overall-comment" }],
      });
    });

    it("reports done when every thread is cleared", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n\nClean prose.\n");

      const openPromise = runCli(
        ["open", documentPath, "--loop", "--json", "--batch-window", "0"],
        test.deps,
      );
      const port = await waitForPersistedPort(test.deps.env);
      await submitDoneReviewing(port, {});

      const exitCode = await openPromise;
      const payload = parseOnlyJsonLog<LoopPayload>(test.logs);

      expect(exitCode).toBe(0);
      expect(payload).toMatchObject({
        timedOut: false,
        done: true,
        doneReason: "threads-cleared",
      });
    });

    it("reports the loop continuing when threads stay open", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);

      const openPromise = runCli(
        ["open", documentPath, "--loop", "--json", "--batch-window", "0"],
        test.deps,
      );
      const port = await waitForPersistedPort(test.deps.env);
      await submitDoneReviewing(port, {
        overallComment: "Please prioritize the CLI contract.",
      });

      const exitCode = await openPromise;
      const payload = parseOnlyJsonLog<LoopPayload>(test.logs);

      expect(exitCode).toBe(0);
      expect(payload).toMatchObject({
        timedOut: false,
        done: false,
        doneReason: null,
        events: [{ done: false, doneReason: null }],
      });
    });

    it("does not add done fields to open --json output without --loop", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");

      const openPromise = runCli(
        ["open", documentPath, "--json", "--batch-window", "0"],
        test.deps,
      );
      const port = await waitForPersistedPort(test.deps.env);
      await submitDoneReviewing(port, {});

      await openPromise;
      const payload = parseOnlyJsonLog<Record<string, unknown>>(test.logs);

      expect(payload).not.toHaveProperty("done");
      expect(payload).not.toHaveProperty("doneReason");
    });

    it("prints the done-signal in human output", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);

      const openPromise = runCli(
        ["open", documentPath, "--loop", "--batch-window", "0"],
        test.deps,
      );
      const port = await waitForPersistedPort(test.deps.env);
      await submitDoneReviewing(port, { overallComment: "lgtm" });

      const exitCode = await openPromise;

      expect(exitCode).toBe(0);
      expect(test.logs).toContain(`Review completed for ${documentPath}.`);
      expect(test.logs).toContain(
        "Reviewer signaled done: the overall comment says the review is done.",
      );
    });

    it("prints the open thread count in human output when the loop continues", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);

      const openPromise = runCli(
        ["open", documentPath, "--loop", "--batch-window", "0"],
        test.deps,
      );
      const port = await waitForPersistedPort(test.deps.env);
      await submitDoneReviewing(port, {});

      const exitCode = await openPromise;

      expect(exitCode).toBe(0);
      expect(test.logs).toContain(
        "Review continues: 1 item(s) still open and no done-signal. Act on the feedback and reopen the document.",
      );
    });

    it("reports the loop continuing when the watch times out", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");

      const exitCode = await runCli(
        [
          "open",
          documentPath,
          "--loop",
          "--json",
          "--timeout",
          "0.2",
          "--batch-window",
          "0",
        ],
        test.deps,
      );
      const payload = parseOnlyJsonLog<LoopPayload>(test.logs);

      expect(exitCode).toBe(1);
      expect(payload).toMatchObject({
        timedOut: true,
        done: false,
        doneReason: null,
      });
    });

    it("reports disconnected and exits 1 when the server dies mid-round and stays down", async () => {
      const test = createTestDependencies();
      const deps = {
        ...test.deps,
        env: { ...test.deps.env, ROUGHDRAFT_WATCH_RECONNECT_SECONDS: "1" },
      };
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);

      const openPromise = runCli(
        ["open", documentPath, "--loop", "--json", "--batch-window", "0"],
        deps,
      );
      await waitForPersistedPort(test.deps.env);
      for (const pid of [...serverByPid.keys()]) {
        await test.deps.stopProcess(pid);
      }

      const exitCode = await openPromise;
      const payload = parseOnlyJsonLog<
        LoopPayload & { disconnected: boolean; error: string }
      >(test.logs);

      expect(exitCode).toBe(1);
      expect(payload).toMatchObject({
        disconnected: true,
        done: false,
        doneReason: null,
      });
      expect(payload.error).toContain("did not come back within 1 s");
      expect(payload.error).toContain("roughdraft open draft.md");
      expect(test.errors.join("\n")).toContain("stopped during the review");
    });

    it("completes the blocking open when the server restarts on the same port mid-round", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, OPEN_THREAD_DRAFT);
      fs.writeFileSync(path.join(projectDir, "earlier.md"), "# Earlier\n");
      // Earlier rounds on the first server move its event sequence past
      // where the restarted server starts counting.
      const first = await ensureServerRunning(test.deps, { projectDir });
      for (let round = 0; round < 3; round += 1) {
        await fetch(`${first.server.url}/api/review-events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectPath: projectDir, path: "earlier.md" }),
        });
      }

      const openPromise = runCli(
        ["open", documentPath, "--loop", "--json", "--batch-window", "0"],
        test.deps,
      );
      const port = await waitForPersistedPort(test.deps.env);
      for (const pid of [...serverByPid.keys()]) {
        await test.deps.stopProcess(pid);
      }
      // `roughdraft start` (or an upgrade) brings a new server up on the
      // same port; its event queue starts over.
      await test.deps.spawnServerProcess({ port, projectDir });
      await waitForPersistedPort(test.deps.env);
      await submitDoneReviewing(port, { overallComment: "lgtm" });

      const exitCode = await openPromise;
      const payload = parseOnlyJsonLog<LoopPayload>(test.logs);

      expect(exitCode).toBe(0);
      expect(payload).toMatchObject({
        timedOut: false,
        done: true,
        doneReason: "overall-comment",
      });
      expect(test.errors.join("\n")).toContain("Reconnected");
    }, 15_000);

    it("rejects --loop together with --no-watch or --print-url", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");

      expect(
        await runCli(["open", documentPath, "--loop", "--no-watch"], test.deps),
      ).toBe(2);
      expect(
        await runCli(
          ["open", documentPath, "--loop", "--print-url"],
          test.deps,
        ),
      ).toBe(2);
      expect(test.errors).toEqual([
        "Use either --loop or --no-watch, not both.",
        "Use either --loop or --print-url, not both.",
      ]);
    });

    it("rejects --loop on the watch command", async () => {
      const test = createTestDependencies();
      const documentPath = path.join(projectDir, "draft.md");
      fs.writeFileSync(documentPath, "# Draft\n");

      const exitCode = await runCli(
        ["watch", documentPath, "--loop"],
        test.deps,
      );

      expect(exitCode).toBe(2);
      expect(test.errors).toEqual(["Unknown flag: --loop"]);
    });

    it("documents --loop in open help", async () => {
      const test = createTestDependencies();

      const exitCode = await runCli(["open", "--help"], test.deps);

      expect(exitCode).toBe(0);
      expect(test.logs).toContain(
        "  roughdraft open <path> [--label <text>] [--no-open] [--no-watch] [--loop] [--print-url] [--port <port>]",
      );
      expect(test.logs.join("\n")).toContain("  --loop ");
    });
  });

  it("cleans stale state during status checks", async () => {
    const test = createTestDependencies();
    const stateFilePath = getServerStateFilePath(test.deps.env);

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: 3999,
        pid: 999999,
        startedAt: new Date().toISOString(),
        url: "http://localhost:3999",
      }),
    );

    const exitCode = await runCli(["status"], test.deps);

    expect(exitCode).toBe(1);
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("reports and reuses an unmanaged server when the tracked pid is stale", async () => {
    const logs: string[] = [];
    const stateFilePath = path.join(stateDir, "server.json");

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      log: (message) => logs.push(message),
      error: () => {},
    });

    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "# Draft\n");

    const statusExitCode = await runCli(["status"], deps);
    const openExitCode = await runCli(
      ["open", documentPath, "--no-watch"],
      deps,
    );

    expect(statusExitCode).toBe(0);
    expect(openExitCode).toBe(0);
    expect(logs).toContain(
      `Roughdraft is running at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
    );
    expect(logs).toContain(
      `This server is not managed by ${getServerStateFilePath(deps.env)}.`,
    );
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("rejects directories before opening", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["open", projectDir], test.deps);

    expect(exitCode).toBe(1);
    expect(test.getSpawnCount()).toBe(0);
    expect(test.errors).toContain(
      `Roughdraft can only open .md files: ${projectDir}`,
    );
    expect(test.getLastOpenedUrl()).toBeNull();
  });

  it("cleans stale state and warns when another Roughdraft instance owns the port during stop", async () => {
    const errors: string[] = [];
    const stateFilePath = path.join(stateDir, "server.json");

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: () => false,
      stopProcess: async () => {},
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      log: () => {},
      error: (message) => errors.push(message),
    });

    const stopExitCode = await runCli(["stop"], deps);

    expect(stopExitCode).toBe(1);
    expect(errors).toContain(
      `Stopped tracked Roughdraft process 424242, but another Roughdraft instance is still running at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}.`,
    );
    expect(fs.existsSync(stateFilePath)).toBeFalsy();
  });

  it("stops a confidently identified unmanaged server with stop --all", async () => {
    const logs: string[] = [];
    let unmanagedRunning = true;
    let stoppedPid: number | null = null;

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (
          unmanagedRunning &&
          url.pathname === "/api/status" &&
          url.port === String(ROUGHDRAFT_DEFAULT_PORT)
        ) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              pid: 4242,
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      isProcessRunning: (pid) => unmanagedRunning && pid === 4242,
      stopProcess: async (pid) => {
        stoppedPid = pid;
        unmanagedRunning = false;
      },
      spawnServerProcess: async () => {
        throw new Error("should not spawn");
      },
      openUrl: () => "disabled",
      log: (message) => logs.push(message),
      error: () => {},
    });

    const exitCode = await runCli(["stop", "--all"], deps);

    expect(exitCode).toBe(0);
    expect(stoppedPid).toBe(4242);
    expect(logs).toContain(
      `Stopped unmanaged Roughdraft at http://localhost:${ROUGHDRAFT_DEFAULT_PORT}.`,
    );
  });

  it("documents extended review syntax in criticmarkup help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "criticmarkup"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("When adding new review feedback:");
    expect(test.logs).toContain(
      "  Prefer compact references like {>>Comment<<}{#c1} with metadata in final YAML endmatter.",
    );
    expect(test.logs).toContain(
      "  Use `c1`, `c2`, etc. for comment ids and `s1`, `s2`, etc. for suggested-change ids.",
    );
    expect(test.logs).toContain("Suggested changes with ids:");
    expect(test.logs).toContain("  Add {++one concrete example++}{#s1}.");
    expect(test.logs).toContain(
      "  Replace {~~vague phrasing~>specific wording~~}{#s2}.",
    );
    expect(test.logs).toContain("Reply to an existing comment:");
    expect(test.logs).toContain(
      "  Existing inline attribute metadata is still accepted for compatibility.",
    );
    expect(test.logs).toContain(
      "  Comment ids are document-local and usually look like `c1`, `c2`, `c3`.",
    );
    expect(test.logs).toContain(
      "  Treat CriticMarkup inside fenced code blocks as literal example text.",
    );
    expect(test.logs).toContain(
      "  https://roughdraft.md/spec/roughdraft-flavored-markdown.md",
    );
  });

  it("prints copyable criticmarkup suggestion examples with required YAML metadata", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "criticmarkup"], test.deps);
    const example = extractHelpExample(
      test.logs,
      "Suggested changes with ids:",
      "Reply to an existing comment:",
    );
    const validation = validateRoughdraftMarkdown(example);

    expect(exitCode).toBe(0);
    expect(example).toContain("suggestions:");
    expect(example).toContain("  s1:");
    expect(example).toContain("  s2:");
    expect(validation.diagnostics).toEqual([]);
    expect(validation.summary.suggestions).toBe(2);
  });

  it("points general help to agent setup", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  help agent         Print the agent setup prompt",
    );
    expect(test.logs).toContain("Agent setup: https://roughdraft.md/setup.md");
    expect(test.logs).toContain(
      "Use `roughdraft help agent` for a copyable setup prompt.",
    );
  });

  it("prints a copyable agent setup prompt", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["help", "agent"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "To set up your coding agent, paste this into it:",
    );
    expect(test.logs).toContain(
      "Install Roughdraft for me using `npm i -g roughdraft`, then read https://roughdraft.md/setup.md and set yourself up to use it.",
    );
    expect(test.logs).toContain(
      "This command only prints setup text. It does not edit agent instruction files.",
    );
  });

  it("keeps CLAUDE.md as a short compatibility shim to AGENTS.md", () => {
    const claudePath = path.join(serverRoot, "CLAUDE.md");
    const claude = fs.readFileSync(claudePath, "utf8");

    expect(claude.length).toBeLessThan(200);
    expect(claude).toContain("@AGENTS.md");
    expect(claude).toContain("compatibility shim");
    expect(fs.lstatSync(claudePath).isSymbolicLink()).toBe(false);
  });

  it("treats removed install command as an unknown command", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["install"], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain("Unknown command: install.");
    expect(test.logs).toEqual([]);
  });

  it("prints package version only for --version", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["--version"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toHaveLength(1);
    expect(test.logs[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("shows per-command help", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["open", "--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "  roughdraft open <path> [--label <text>] [--no-open] [--no-watch] [--loop] [--print-url] [--port <port>]",
    );
    expect(test.logs).toContain(
      "  --no-watch           Open the file without waiting",
    );
    expect(test.logs).toContain(
      "  --timeout <seconds>  Maximum watch time; omitted means no timeout",
    );
  });

  it("shows doctor help with the optional markdown path", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["doctor", "--help"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("  roughdraft doctor [path] [--json]");
  });

  it("rejects unknown command typos with suggestions", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["stats"], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(
      "Unknown command: stats. Did you mean status?",
    );
  });

  it("supports agent-setup as a direct setup helper", async () => {
    const test = createTestDependencies();

    const exitCode = await runCli(["agent-setup"], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain(
      "Live setup instructions: https://roughdraft.md/setup.md",
    );
  });

  it("reports dev wrapper metadata from doctor --json", async () => {
    const logs: string[] = [];
    const wrapperPath = path.join(tempDir, "bin", "roughdraft-dev-lyon-v2");
    const devStateDir = path.join(
      tempDir,
      ".roughdraft",
      "dev",
      "roughdraft-dev-lyon-v2",
    );
    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_DEV_WRAPPER_NAME: "roughdraft-dev-lyon-v2",
        ROUGHDRAFT_DEV_WRAPPER_PATH: wrapperPath,
        ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT: serverRoot,
        ROUGHDRAFT_STATE_DIR: devStateDir,
      },
      cwd: projectDir,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      log: (message) => logs.push(message),
      error: () => {},
    });

    const exitCode = await runCli(["doctor", "--json"], deps);
    const payload = parseOnlyJsonLog<{
      devWrapper: {
        commandName: string;
        path: string;
        repoRoot: string;
        repoRootMatches: boolean;
        stateDir: string;
      };
    }>(logs);

    expect(exitCode).toBe(0);
    expect(payload.devWrapper).toEqual({
      commandName: "roughdraft-dev-lyon-v2",
      path: wrapperPath,
      repoRoot: serverRoot,
      repoRootMatches: true,
      stateDir: devStateDir,
    });
  });

  it("validates a conforming markdown file from doctor path", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(
      documentPath,
      'Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.\n',
    );

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(0);
    expect(test.logs).toContain("Roughdraft Markdown doctor: draft.md");
    expect(test.logs).toContain("Status: passed");
    expect(test.logs).toContain("Found 1 comment(s) and 0 suggestion(s).");
  });

  it("returns validation errors from doctor path", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(documentPath, "{>>Needs metadata<<}\n");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(1);
    expect(test.logs).toContain("Status: failed");
    expect(test.logs).toContain("Errors:");
    expect(test.logs).toContain(
      "  1:1  Missing required metadata attribute `id`.",
    );
  });

  it("emits JSON validation output from doctor path --json", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.md");
    fs.writeFileSync(
      documentPath,
      [
        '{>>First<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}',
        '{++Second++}{id="c1" by="user" at="2026-04-28T12:01:00.000Z"}',
      ].join("\n"),
    );

    const exitCode = await runCli(
      ["doctor", documentPath, "--json"],
      test.deps,
    );
    const payload = parseOnlyJsonLog<{
      kind: string;
      path: string;
      ok: boolean;
      errors: Array<{ code: string }>;
      summary: { comments: number; suggestions: number };
    }>(test.logs);

    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({
      kind: "markdown",
      path: documentPath,
      ok: false,
      summary: {
        comments: 1,
        suggestions: 1,
      },
    });
    expect(payload.errors.map((error) => error.code)).toContain("duplicate-id");
  });

  it("rejects missing markdown files from doctor path before validation", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "missing.md");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(`Path not found: ${documentPath}`);
  });

  it("rejects non-markdown doctor paths as usage errors", async () => {
    const test = createTestDependencies();
    const documentPath = path.join(projectDir, "draft.txt");
    fs.writeFileSync(documentPath, "# Draft\n");

    const exitCode = await runCli(["doctor", documentPath], test.deps);

    expect(exitCode).toBe(2);
    expect(test.errors).toContain(
      `Roughdraft doctor can only validate .md files: ${documentPath}`,
    );
  });

  it("starts a new server when the preferred port belongs to another checkout", async () => {
    const stateFilePath = path.join(stateDir, "server.json");
    const otherServerRoot = path.join(tempDir, "other-checkout");
    let spawnedPort: number | null = null;
    let spawnedProjectDir: string | null = null;
    let spawned = false;

    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        port: ROUGHDRAFT_DEFAULT_PORT,
        pid: 424242,
        startedAt: new Date().toISOString(),
        url: `http://localhost:${ROUGHDRAFT_DEFAULT_PORT}`,
      }),
    );

    const deps = createCliDependencies({
      env: {
        ...process.env,
        ROUGHDRAFT_STATE_DIR: stateDir,
      },
      cwd: projectDir,
      fetchImpl: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(
                typeof input === "string" ? input : input.url,
                "http://localhost",
              );

        if (url.pathname !== "/api/status") {
          throw new Error("Unexpected request");
        }

        if (url.port === String(ROUGHDRAFT_DEFAULT_PORT)) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT,
              projectDir: path.join(tempDir, "other-project"),
              serverRoot: otherServerRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.port === String(ROUGHDRAFT_DEFAULT_PORT + 1) && spawned) {
          return new Response(
            JSON.stringify({
              backend: "local-files",
              port: ROUGHDRAFT_DEFAULT_PORT + 1,
              projectDir,
              serverRoot,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error("connect ECONNREFUSED");
      },
      findAvailablePortImpl: async () => ROUGHDRAFT_DEFAULT_PORT + 1,
      spawnServerProcess: async ({ port, projectDir: nextProjectDir }) => {
        spawned = true;
        spawnedPort = port;
        spawnedProjectDir = nextProjectDir;
        return { pid: 1001 };
      },
      isProcessRunning: (pid) => pid === 424242,
      stopProcess: async () => {},
      openUrl: () => "disabled",
      log: () => {},
      error: () => {},
    });

    const result = await ensureServerRunning(deps, { projectDir });

    expect(result.reused).toBe(false);
    expect(spawnedPort).toBe(ROUGHDRAFT_DEFAULT_PORT + 1);
    expect(spawnedProjectDir).toBe(projectDir);
    expect(result.server.port).toBe(ROUGHDRAFT_DEFAULT_PORT + 1);
  });
});

describe("runCli open in remote mode", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-remote-"));
    projectDir = path.join(tempDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function startRemoteHost(remoteDocumentToken?: string): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    const { app } = createApp({
      homeDir: tempDir,
      remoteDocumentToken,
      staticDirPath: tempDir,
    });
    const server = createHttpServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind remote host");
    }
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  it("prints register failure and exits 1 when the remote host is unreachable", async () => {
    const filePath = path.join(projectDir, "draft.md");
    fs.writeFileSync(filePath, "# hello\n");

    const logs: string[] = [];
    const errors: string[] = [];

    const exitCode = await runCli(["open", filePath], {
      env: { ROUGHDRAFT_HOST: "http://127.0.0.1:1" },
      cwd: projectDir,
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
      openUrl: () => "disabled",
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        updateAvailable: false,
        updateCommand: "",
      }),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Could not register remote session");
  });

  it("rejects non-.md targets in remote mode without contacting the host", async () => {
    const filePath = path.join(projectDir, "notes.txt");
    fs.writeFileSync(filePath, "hello");

    const errors: string[] = [];
    let fetchCalls = 0;

    const exitCode = await runCli(["open", filePath], {
      env: { ROUGHDRAFT_HOST: "http://127.0.0.1:1" },
      cwd: projectDir,
      log: () => {},
      error: (m) => errors.push(m),
      openUrl: () => "disabled",
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("", { status: 200 });
      },
      resolveUpdateStatus: async () => ({
        packageName: "roughdraft",
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        updateAvailable: false,
        updateCommand: "",
      }),
    });

    expect(exitCode).toBe(1);
    expect(fetchCalls).toBe(0);
    expect(errors.join("\n")).toContain("can only open .md files");
  });

  it("registers a session, opens the viewer URL, and writes save events to disk", {
    timeout: 15_000,
  }, async () => {
    const remote = await startRemoteHost();
    try {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "before\n");

      const logs: string[] = [];
      const errors: string[] = [];
      let openedUrl: string | null = null;

      const cliPromise = runCli(["open", filePath], {
        env: { ROUGHDRAFT_HOST: remote.url },
        cwd: projectDir,
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        openUrl: (url) => {
          openedUrl = url;
          return "disabled";
        },
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.1.0",
          updateAvailable: false,
          updateCommand: "",
        }),
      });

      // Wait for the CLI to register and open the SSE channel.
      const deadline = Date.now() + 4000;
      while (openedUrl === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(openedUrl).not.toBeNull();
      const sessionId = new URL(
        openedUrl as unknown as string,
      ).searchParams.get("session");
      expect(sessionId).toBeTruthy();

      // Wait until the server actually has the SSE client connected before PUTting.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Trigger a save event by PUTting new content.
      const putResponse = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "after\n" }),
        },
      );
      expect(putResponse.status).toBe(200);

      // Wait until the file on disk reflects the save.
      const writeDeadline = Date.now() + 4000;
      while (
        fs.readFileSync(filePath, "utf-8") !== "after\n" &&
        Date.now() < writeDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.readFileSync(filePath, "utf-8")).toBe("after\n");

      // Closing the server ends the SSE stream and lets the CLI exit cleanly.
      await remote.close();
      const exitCode = await cliPromise;
      expect(exitCode).toBe(0);
      expect(
        logs.some((m) => m.includes("Opened remote Roughdraft session")),
      ).toBe(true);
    } finally {
      await remote.close();
    }
  });

  it("opens the remote viewer in an Orca tab inside an Orca terminal", {
    timeout: 15_000,
  }, async () => {
    const remote = await startRemoteHost();
    try {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "before\n");
      const orcaCalls: string[][] = [];
      let openedInBrowser = false;

      const cliPromise = runCli(["open", filePath], {
        env: {
          ROUGHDRAFT_HOST: remote.url,
          ORCA_WORKTREE_ID: "repo-1::/Users/me/orca/workspaces/app/feature",
        },
        cwd: projectDir,
        log: () => {},
        error: () => {},
        openUrl: () => {
          openedInBrowser = true;
          return "disabled";
        },
        runOrcaCommand: async (_command, args) => {
          orcaCalls.push(args);
          const result =
            args[1] === "list"
              ? { tabs: [] }
              : { browserPageId: "page-remote", switched: 0 };
          return {
            exitCode: 0,
            stdout: JSON.stringify({ ok: true, result }),
            stderr: "",
          };
        },
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.1.0",
          updateAvailable: false,
          updateCommand: "",
        }),
      });

      const deadline = Date.now() + 4000;
      while (orcaCalls.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const createCall = orcaCalls.find((args) => args[1] === "create");
      const viewerUrl = new URL(createCall?.[3] ?? "about:blank");

      expect(viewerUrl.origin).toBe(remote.url);
      expect(viewerUrl.searchParams.get("session")).toBeTruthy();
      expect(openedInBrowser).toBe(false);

      await remote.close();
      expect(await cliPromise).toBe(0);
    } finally {
      await remote.close();
    }
  });

  it("authenticates remote registration and the CLI save-back stream with ROUGHDRAFT_TOKEN", {
    timeout: 15_000,
  }, async () => {
    const remote = await startRemoteHost("secret-token");
    try {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "before\n");

      const logs: string[] = [];
      const errors: string[] = [];
      let openedUrl: string | null = null;

      const cliPromise = runCli(["open", filePath], {
        env: {
          ROUGHDRAFT_HOST: remote.url,
          ROUGHDRAFT_TOKEN: "secret-token",
        },
        cwd: projectDir,
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        openUrl: (url) => {
          openedUrl = url;
          return "disabled";
        },
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.1.0",
          updateAvailable: false,
          updateCommand: "",
        }),
      });

      const openDeadline = Date.now() + 4000;
      while (openedUrl === null && Date.now() < openDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(openedUrl).not.toBeNull();

      const parsedOpenedUrl = new URL(openedUrl as unknown as string);
      const sessionId = parsedOpenedUrl.searchParams.get("session");
      expect(sessionId).toBeTruthy();
      expect(parsedOpenedUrl.searchParams.get("token")).toBe("secret-token");

      await new Promise((resolve) => setTimeout(resolve, 100));

      const putResponse = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
        {
          method: "PUT",
          headers: {
            Authorization: "Bearer secret-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "after-token\n" }),
        },
      );
      expect(putResponse.status).toBe(200);

      const writeDeadline = Date.now() + 4000;
      while (
        fs.readFileSync(filePath, "utf-8") !== "after-token\n" &&
        Date.now() < writeDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.readFileSync(filePath, "utf-8")).toBe("after-token\n");

      await remote.close();
      expect(await cliPromise).toBe(0);
      expect(errors).toEqual([]);
      expect(
        logs.some((m) => m.includes("Opened remote Roughdraft session")),
      ).toBe(true);
    } finally {
      await remote.close();
    }
  });

  it("writes remote saves to disk without altering markdown constructs", {
    timeout: 15_000,
  }, async () => {
    const remote = await startRemoteHost();
    try {
      const filePath = path.join(projectDir, "roundtrip.md");
      const originalContent = [
        "---",
        "title: Remote Roundtrip",
        "---",
        "",
        "# Remote Roundtrip",
        "",
        "{>>Keep this comment<<}",
        "{++new text++}",
        "{--old text--}",
        "{~~old~>new~~}",
        "{==highlight==}",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "- [ ] task",
        "",
        "```md",
        "{>>literal example<<}",
        "```",
        "",
        "Inline `{>>literal<<}` and [local](./neighbor.md).",
        "",
        "<aside>supported html</aside>",
        "",
      ].join("\n");
      const savedContent = originalContent.replace(
        "# Remote Roundtrip",
        "# Remote Roundtrip Edited",
      );
      fs.writeFileSync(filePath, originalContent);

      const logs: string[] = [];
      const errors: string[] = [];
      let openedUrl: string | null = null;

      const cliPromise = runCli(["open", filePath], {
        env: { ROUGHDRAFT_HOST: remote.url },
        cwd: projectDir,
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        openUrl: (url) => {
          openedUrl = url;
          return "disabled";
        },
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.1.0",
          updateAvailable: false,
          updateCommand: "",
        }),
      });

      const openDeadline = Date.now() + 4000;
      while (openedUrl === null && Date.now() < openDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(openedUrl).not.toBeNull();

      const sessionId = new URL(
        openedUrl as unknown as string,
      ).searchParams.get("session");
      expect(sessionId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const loaded = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
      );
      expect(loaded.status).toBe(200);
      const payload = (await loaded.json()) as { version: string };

      const putResponse = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: savedContent,
            expectedVersion: payload.version,
          }),
        },
      );
      expect(putResponse.status).toBe(200);

      const writeDeadline = Date.now() + 4000;
      while (
        fs.readFileSync(filePath, "utf-8") !== savedContent &&
        Date.now() < writeDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.readFileSync(filePath, "utf-8")).toBe(savedContent);

      await remote.close();
      expect(await cliPromise).toBe(0);
      expect(errors).toEqual([]);
      expect(
        logs.some((m) => m.includes("Saved") && m.includes("roundtrip.md")),
      ).toBe(true);
    } finally {
      await remote.close();
    }
  });

  it("keeps the CLI save-back stream when a browser also watches the remote session", {
    timeout: 15_000,
  }, async () => {
    const remote = await startRemoteHost();
    let browserEventsReader: ReadableStreamDefaultReader<Uint8Array> | null =
      null;

    try {
      const filePath = path.join(projectDir, "draft.md");
      fs.writeFileSync(filePath, "before\n");

      const logs: string[] = [];
      const errors: string[] = [];
      let openedUrl: string | null = null;
      let cliSettled = false;

      const cliPromise = runCli(["open", filePath], {
        env: { ROUGHDRAFT_HOST: remote.url },
        cwd: projectDir,
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        openUrl: (url) => {
          openedUrl = url;
          return "disabled";
        },
        resolveUpdateStatus: async () => ({
          packageName: "roughdraft",
          currentVersion: "0.1.0",
          latestVersion: "0.1.0",
          updateAvailable: false,
          updateCommand: "",
        }),
      }).finally(() => {
        cliSettled = true;
      });

      const openDeadline = Date.now() + 4000;
      while (openedUrl === null && Date.now() < openDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(openedUrl).not.toBeNull();

      const sessionId = new URL(
        openedUrl as unknown as string,
      ).searchParams.get("session");
      expect(sessionId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const browserEvents = await fetch(
        `${remote.url}/api/remote-document/${sessionId}/events?role=viewer`,
      );
      expect(browserEvents.status).toBe(200);
      browserEventsReader = browserEvents.body?.getReader() ?? null;
      expect(browserEventsReader).not.toBeNull();

      const decoder = new TextDecoder();
      let connectedChunk = "";
      const browserConnectDeadline = Date.now() + 4000;
      while (
        !connectedChunk.includes("event: connected") &&
        Date.now() < browserConnectDeadline
      ) {
        const chunk = await browserEventsReader?.read();
        if (!chunk || chunk.done) break;
        connectedChunk += decoder.decode(chunk.value);
      }
      expect(connectedChunk).toContain("event: connected");

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(cliSettled).toBe(false);

      const putResponse = await fetch(
        `${remote.url}/api/remote-document/${sessionId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "after-browser-watch\n" }),
        },
      );
      expect(putResponse.status).toBe(200);

      const writeDeadline = Date.now() + 4000;
      while (
        fs.readFileSync(filePath, "utf-8") !== "after-browser-watch\n" &&
        Date.now() < writeDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.readFileSync(filePath, "utf-8")).toBe("after-browser-watch\n");

      await browserEventsReader?.cancel();
      await remote.close();
      expect(await cliPromise).toBe(0);
      expect(errors).toEqual([]);
      expect(
        logs.some((m) => m.includes("Opened remote Roughdraft session")),
      ).toBe(true);
    } finally {
      await browserEventsReader?.cancel().catch(() => undefined);
      await remote.close();
    }
  });
});
