#!/usr/bin/env bash
# scripts/analyze.sh
#
# Run the project analyzer against the current directory.
# Produces .workflow/profile.yml and prints a summary.

set -euo pipefail
DEVOPS_ROOT="${DEVOPS_ROOT:-$HOME/DevOPs}"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required (>=20). Install: https://nodejs.org/" >&2
    exit 1
fi

# Compile scan.ts if needed (use tsx for zero-config TS execution if available)
if command -v tsx >/dev/null 2>&1; then
    exec tsx "$DEVOPS_ROOT/analyzer/scan.ts"
elif command -v node >/dev/null 2>&1 && node --version | grep -qE 'v(2[2-9]|[3-9][0-9])'; then
    # Node 22+ has native TS support (experimental)
    exec node --experimental-strip-types "$DEVOPS_ROOT/analyzer/scan.ts"
else
    echo "Install tsx for TypeScript execution: npm i -g tsx" >&2
    echo "Or use Node 22+ with --experimental-strip-types" >&2
    exit 1
fi
