import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Bug G: `npm i -g roughdraft` installs @roughdraft/rfm as a `file:` link to
 * packages/rfm but never installs rfm's own dependencies, so the CLI dies
 * with ERR_MODULE_NOT_FOUND for `yaml`. The published package is only
 * self-contained when every third-party dependency of the code it ships is
 * declared in the ROOT package.json: npm installs those in the package's
 * top-level node_modules, which Node reaches when resolving from
 * packages/rfm/dist or packages/server/dist.
 */

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

interface PackageManifest {
  name?: string;
  bin?: string | Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
}

function readManifest(packageDir: string): PackageManifest {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, packageDir, "package.json"), "utf8"),
  ) as PackageManifest;
}

function normalizePackagePath(entry: string): string {
  return entry.replace(/^\.\//, "").replace(/\/+$/, "");
}

function isWorkspaceDependency(name: string, spec: string): boolean {
  return name.startsWith("@roughdraft/") || spec.startsWith("workspace:");
}

describe("published roughdraft package (Bug G)", () => {
  const root = readManifest(".");

  it("declares every third-party dependency of shipped workspace code in the root dependencies", () => {
    const rootDependencies = root.dependencies ?? {};
    const missing = ["packages/rfm", "packages/server"].flatMap(
      (packageDir) => {
        const manifest = readManifest(packageDir);
        return Object.entries(manifest.dependencies ?? {})
          .filter(([name, spec]) => !isWorkspaceDependency(name, spec))
          .filter(([name]) => !Object.hasOwn(rootDependencies, name))
          .map(
            ([name, spec]) => `${name}@${spec} (needed by ${manifest.name})`,
          );
      },
    );

    expect(missing).toEqual([]);
  });

  it("ships every file the roughdraft bin loads at runtime", () => {
    const binPaths =
      typeof root.bin === "string" ? [root.bin] : Object.values(root.bin ?? {});
    const runtimePaths = [
      ...binPaths,
      "packages/server/bin",
      "packages/server/dist",
      "packages/server/defaults.mjs", // imported by dist/network.js
      "packages/rfm/dist",
      "packages/rfm/package.json", // resolves the @roughdraft/rfm link
      "packages/app/dist",
    ].map(normalizePackagePath);
    const files = (root.files ?? []).map(normalizePackagePath);

    const notShipped = runtimePaths.filter(
      (runtimePath) =>
        !files.some(
          (entry) =>
            runtimePath === entry || runtimePath.startsWith(`${entry}/`),
        ),
    );

    expect(notShipped).toEqual([]);
  });
});
