#!/usr/bin/env bash
# Install this fork as the global `roughdraft` CLI, from origin/main only.
#
# Why: on 2026-10-07 the fork was installed from a feature branch cut before
# the fix that stopped tabs from holding event streams. Nothing noticed, and
# for two days "I'm done" stayed on "Sending" in any browser with a few
# Roughdraft tabs open. This script refuses any commit other than origin/main,
# stamps the build with its commit, and restarts the running server and its
# Orca tabs so no old code keeps running after the install.
#
# Usage: pnpm install:fork   (or scripts/install-fork.sh)
# Env:   ROUGHDRAFT_INSTALL_PREFIX  npm prefix to install into (default ~/.local)

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${ROUGHDRAFT_INSTALL_PREFIX:-$HOME/.local}"
installed_root="$prefix/lib/node_modules/roughdraft"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

log() {
  printf '[install-fork] %s\n' "$*"
}

fail() {
  printf '[install-fork] %s\n' "$*" >&2
  exit 1
}

cd "$repo_root"

# The build scripts call `pnpm` by name, so a corepack-only setup needs a shim.
if ! command -v pnpm >/dev/null 2>&1; then
  command -v corepack >/dev/null 2>&1 || fail "pnpm or corepack is required."
  mkdir -p "$work_dir/bin"
  printf '#!/bin/sh\nexec corepack pnpm "$@"\n' >"$work_dir/bin/pnpm"
  chmod +x "$work_dir/bin/pnpm"
  export PATH="$work_dir/bin:$PATH"
fi

[[ -z "$(git status --porcelain)" ]] ||
  fail "The working tree has uncommitted changes. Commit or discard them first."

git fetch --quiet origin main
head_commit="$(git rev-parse HEAD)"
main_commit="$(git rev-parse origin/main)"
[[ "$head_commit" == "$main_commit" ]] ||
  fail "HEAD is ${head_commit:0:7}, origin/main is ${main_commit:0:7}. Install only from origin/main: merge and push first, then run this from a checkout at origin/main."

log "Building ${head_commit:0:7}..."
pnpm install --frozen-lockfile >/dev/null
pnpm build >/dev/null

cat >"$repo_root/packages/server/dist/build-info.json" <<EOF
{
  "commit": "$head_commit",
  "branch": "main",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

npm pack --silent --pack-destination "$work_dir" >/dev/null
tarball="$(ls "$work_dir"/roughdraft-*.tgz)"
npm install --global --silent --prefix "$prefix" "$tarball" >/dev/null

installed_commit="$(node -e 'console.log(require(process.argv[1]).commit)' \
  "$installed_root/packages/server/dist/build-info.json" 2>/dev/null || true)"
[[ "$installed_commit" == "$head_commit" ]] ||
  fail "The install did not take: $installed_root reports '${installed_commit:-nothing}'."
log "Installed ${head_commit:0:7} into $installed_root."

roughdraft_bin="$prefix/bin/roughdraft"
if "$roughdraft_bin" status >/dev/null 2>&1; then
  server_url="$("$roughdraft_bin" status 2>/dev/null | grep -Eo 'http://[^ ]+' | head -1)"
  log "Restarting the server at $server_url..."
  "$roughdraft_bin" stop >/dev/null
  (cd "$HOME" && "$roughdraft_bin" start >/dev/null)

  # Open tabs keep running the old code until they reload.
  if command -v orca >/dev/null 2>&1 && [[ -n "$server_url" ]]; then
    pages="$(orca tab list --worktree all --json 2>/dev/null |
      node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => (raw += chunk));
        process.stdin.on("end", () => {
          try {
            const tabs = JSON.parse(raw).result.tabs ?? [];
            for (const tab of tabs) {
              if ((tab.url ?? "").startsWith(process.argv[1])) {
                console.log(tab.browserPageId);
              }
            }
          } catch {}
        });
      ' "$server_url" || true)"
    reloaded=0
    for page in $pages; do
      orca reload --page "$page" --json >/dev/null 2>&1 && reloaded=$((reloaded + 1))
    done
    log "Reloaded $reloaded Orca tab(s). Reload any other browser tab on $server_url by hand."
  fi
else
  log "No server running; the next 'roughdraft open' starts the new build."
fi
