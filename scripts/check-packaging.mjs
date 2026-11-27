#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Packs the repo, installs the tarball into a throwaway prefix, and runs the
// installed CLI. This is the only check that exercises the published artifact:
// npm does not install dependencies of `file:` sub-packages, so a runtime
// dependency declared only under packages/*/package.json resolves in the
// workspace and is missing from a real install. That gap shipped once already
// and crashed every fresh install with ERR_MODULE_NOT_FOUND before any command
// ran.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Built output the tarball's `files` list ships. Packing without these produces
// a tarball that installs fine and then fails on its first import.
const requiredBuildOutputs = [
  "packages/rfm/dist/index.js",
  "packages/server/dist/cli.js",
];

// Assigned once the temporary directory exists. `fail()` has to remove it
// itself: process.exit() does not unwind the stack, so the finally block at the
// end of this file never runs on a failure, and each failed run would otherwise
// strand ~15 MB in the OS temp directory.
let workDir = null;

function cleanUpWorkDir() {
  if (workDir === null) return;
  const doomed = workDir;
  workDir = null;
  fs.rmSync(doomed, { recursive: true, force: true });
}

function fail(message, details = []) {
  console.error(`Packaging guard failed: ${message}\n`);
  for (const detail of details) {
    if (detail.trim().length > 0) console.error(detail);
  }
  cleanUpWorkDir();
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });

  if (result.error) {
    fail(`could not run \`${command} ${args.join(" ")}\`.`, [
      String(result.error),
    ]);
  }

  return result;
}

// The installed CLI must resolve its dependencies from its own install tree.
// NODE_PATH or a NODE_OPTIONS loader pointing back at this repo would let the
// workspace satisfy an import the tarball forgot to declare, which is exactly
// the failure this guard exists to catch.
function isolatedEnv(stateDir) {
  const env = { ...process.env, ROUGHDRAFT_STATE_DIR: stateDir };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  return env;
}

function describeExit(result) {
  return [
    `exit code: ${result.status ?? "null"}`,
    result.signal ? `signal: ${result.signal}` : "",
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ];
}

// A missing root dependency surfaces as a resolution error from inside the
// install tree, so name the cause rather than leaving a raw stack trace.
function assertCliSucceeded(label, result) {
  const output = `${result.stdout}${result.stderr}`;
  const missingPackage = /Cannot find package '([^']+)'/.exec(output);

  if (missingPackage) {
    fail(
      `\`roughdraft ${label}\` could not resolve "${missingPackage[1]}" from the installed package. Declare it under "dependencies" in the root package.json; a declaration under packages/*/package.json does not reach a real install.`,
      describeExit(result),
    );
  }

  if (result.status !== 0) {
    fail(
      `\`roughdraft ${label}\` exited non-zero from the installed package.`,
      describeExit(result),
    );
  }
}

for (const relativePath of requiredBuildOutputs) {
  if (!fs.existsSync(path.join(repoRoot, relativePath))) {
    fail(`${relativePath} is missing. Run \`pnpm build\` first.`);
  }
}

// Outside the repo on purpose: a prefix nested under the worktree would let
// node walk up into the workspace node_modules and resolve what the tarball
// failed to declare.
workDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-packaging-"));
const packDir = path.join(workDir, "pack");
const prefix = path.join(workDir, "prefix");
const stateDir = path.join(workDir, "state");
const startedAt = Date.now();

try {
  for (const dir of [packDir, prefix, stateDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const packed = run("npm", ["pack", "--pack-destination", packDir], {
    cwd: repoRoot,
  });
  if (packed.status !== 0) {
    fail("`npm pack` failed.", describeExit(packed));
  }

  const tarballs = fs
    .readdirSync(packDir)
    .filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    fail(
      `expected \`npm pack\` to write exactly one tarball, found ${tarballs.length}.`,
    );
  }
  const tarballPath = path.join(packDir, tarballs[0]);

  // `--global --prefix` is what `npm i -g` does, aimed at a throwaway
  // directory instead of the machine's global prefix.
  const installed = run("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    tarballPath,
  ]);
  if (installed.status !== 0) {
    fail(
      `installing ${tarballs[0]} into a temporary prefix failed.`,
      describeExit(installed),
    );
  }

  const cliPath = path.join(prefix, "bin", "roughdraft");
  if (!fs.existsSync(cliPath)) {
    fail(
      `the install did not create ${cliPath}. Check the "bin" field in the root package.json.`,
    );
  }

  const help = run(cliPath, ["--help"], {
    cwd: workDir,
    env: isolatedEnv(stateDir),
  });
  assertCliSucceeded("--help", help);
  if (!help.stdout.includes("Commands:")) {
    fail("`roughdraft --help` printed no command list.", describeExit(help));
  }

  const status = run(cliPath, ["status", "--json"], {
    cwd: workDir,
    env: isolatedEnv(stateDir),
  });
  assertCliSucceeded("status --json", status);

  let statusPayload;
  try {
    statusPayload = JSON.parse(status.stdout);
  } catch (error) {
    fail("`roughdraft status --json` did not print JSON.", [
      String(error),
      ...describeExit(status),
    ]);
  }
  if (statusPayload.running !== false) {
    fail(
      `\`roughdraft status --json\` reported running=${JSON.stringify(statusPayload.running)} against an empty state directory; expected false.`,
      describeExit(status),
    );
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `Packed ${tarballs[0]}, installed it into a temporary prefix, and ran \`roughdraft --help\` and \`roughdraft status --json\` from it in ${elapsedSeconds}s.`,
  );
} finally {
  cleanUpWorkDir();
}
