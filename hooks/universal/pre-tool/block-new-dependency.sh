#!/usr/bin/env bash
# hooks/universal/pre-tool/block-new-dependency.sh
#
# Blocks agent-run installs of packages the project has not declared:
#   npm/pnpm/yarn/bun add|install <name>, pip/uv/poetry add|install <name>, cargo add <name>
# when <name> is absent from package.json, requirements*.txt, pyproject.toml or
# Cargo.toml in the current project directory. Plain `npm install` / `npm ci` and
# installs from a requirements file stay allowed. No network access: a model-suggested
# package that does not exist (slopsquatting) is never fetched, it needs owner approval.
#
# Spec: specs/graph/M-masterpiece-standard.md (REQ-M30 / AC-M30.1)

set -euo pipefail

COMMAND="${1:-}"
CLASSIFIER="$(dirname -- "${BASH_SOURCE[0]}")/new-dependency-classifier.mjs"

# exit 0 = allow, exit 2 = block (message on stderr); any other status is a fault.
status=0
node "$CLASSIFIER" "$COMMAND" || status=$?
case "$status" in
    0) exit 0 ;;
    2) exit 2 ;;
    *) echo "DevOPs NEW-DEPENDENCY BLOCK: new-dependency-classifier.mjs failed (status $status); failing closed" >&2
       exit 2 ;;
esac
