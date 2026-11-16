#!/usr/bin/env bash
# Run in Git Bash on Windows. In WSL, use run_linux.sh with Linux runtimes.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js is required. Install Node.js and npm, then reopen Git Bash.' >&2
  exit 1
fi
exec node "$SCRIPT_DIR/scripts/run-dev.mjs" "$@"
