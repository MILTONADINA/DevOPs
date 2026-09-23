#!/usr/bin/env bash
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
if ! cd "$ROOT" 2>/dev/null; then
  echo "graph-preflight: project root unavailable" >&2
  exit 0
fi
bash "$ROOT/scripts/graph-preflight.sh" --check-only || true
exit 0
