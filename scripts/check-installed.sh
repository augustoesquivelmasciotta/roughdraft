#!/usr/bin/env bash
# Daily launchd job (com.augus.roughdraft-fork.check): is the installed
# `roughdraft` the fork's origin/main?
#
# Why: on 2026-10-07 a feature branch without the polling fix was installed,
# and for two days "I'm done" stayed on "Sending". Nothing compared the
# installed build with origin/main. scripts/install-fork.sh stamps each
# install with its commit; this job reads the stamp and compares.
#
# Never installs. Principle #22 surfacing, read by /health-check:
#   status/last-check.json  ts + exit_code + stage + message + log_path
#   macOS notification      only when the check does not pass
#
# Env: ROUGHDRAFT_INSTALL_PREFIX (default ~/.local),
#      ROUGHDRAFT_MAINTENANCE_DIR (default ~/.claude-tlon2/maintenance/roughdraft-fork),
#      ROUGHDRAFT_CHECK_QUIET=1 to skip the notification

set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${ROUGHDRAFT_INSTALL_PREFIX:-$HOME/.local}"
stamp="$prefix/lib/node_modules/roughdraft/packages/server/dist/build-info.json"
maintenance_dir="${ROUGHDRAFT_MAINTENANCE_DIR:-$HOME/.claude-tlon2/maintenance/roughdraft-fork}"
status_file="$maintenance_dir/status/last-check.json"
log_file="$maintenance_dir/logs/check-$(date +%Y-%m-%d).log"
fix="cd \"$repo_root\" && git pull && pnpm install:fork"
mkdir -p "$maintenance_dir/status" "$maintenance_dir/logs"

log() {
  echo "[$(date +%H:%M:%S)] $*" >>"$log_file"
}

finish() {
  local exit_code="$1" stage="$2" message="$3" installed="${4:-}" main="${5:-}"
  python3 - "$exit_code" "$stage" "$message" "$log_file" "$installed" "$main" >"$status_file" <<'PY'
import datetime, json, sys
ec, stage, msg, log, installed, main = sys.argv[1:7]
print(json.dumps({
    "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "exit_code": int(ec), "stage": stage, "message": msg, "log_path": log,
    "installed_commit": installed, "main_commit": main,
}, indent=2))
PY
  log "$stage: $message"
  if [[ "$exit_code" != 0 && -z "${ROUGHDRAFT_CHECK_QUIET:-}" ]]; then
    osascript -e "display notification \"The installed build is not origin/main ($stage). Run pnpm install:fork in the fork.\" with title \"Roughdraft fork: install check\"" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

log "=== Roughdraft fork install check ==="

main_commit="$(git -C "$repo_root" ls-remote origin refs/heads/main 2>>"$log_file" | cut -f1)"
[[ -n "$main_commit" ]] ||
  finish 1 "remote" "Could not read origin/main of $repo_root."

[[ -s "$stamp" ]] ||
  finish 1 "no_stamp" "The installed roughdraft has no build stamp, so it was installed outside install-fork.sh. Fix: $fix" "" "$main_commit"

installed_commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("commit",""))' "$stamp" 2>>"$log_file")"
[[ -n "$installed_commit" ]] ||
  finish 1 "no_stamp" "The build stamp at $stamp has no commit. Fix: $fix" "" "$main_commit"

[[ "$installed_commit" == "$main_commit" ]] ||
  finish 1 "behind" "The installed roughdraft is ${installed_commit:0:7}, origin/main is ${main_commit:0:7}. Fix: $fix" "$installed_commit" "$main_commit"

finish 0 "done" "The installed roughdraft is origin/main (${main_commit:0:7})." "$installed_commit" "$main_commit"
