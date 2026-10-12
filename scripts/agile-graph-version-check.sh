#!/usr/bin/env bash
# scripts/agile-graph-version-check.sh
#
# specs/graph/agile-graph-link.md REQ-8: is the newest published @agile-graph/engine one
# DevOps links (ENGINE_VERSIONS)? If not, install it with its install scripts off (it is
# not reviewed yet) and compare its cloud-default tool hashes with the shipped pins.
# Writes result.json into the folder given, for the weekly workflow to turn into an
# issue. Needs Node 24 to 26 and the public npm registry; not shipped in the package.
#
# Usage: bash scripts/agile-graph-version-check.sh <output-folder>

set -euo pipefail
export GRAPH_ENGINE_NO_FEEDBACK=1   # REQ-5
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: agile-graph-version-check.sh <output-folder>}"
mkdir -p "$OUT"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

LATEST="$(npm view @agile-graph/engine version)"
[[ "$LATEST" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected engine version: $LATEST" >&2; exit 1; }
LISTED="$(node --input-type=module -e "import { ENGINE_VERSIONS } from '$ROOT/analyzer/agile-graph.js'; console.log(ENGINE_VERSIONS.join(' '))")"

if [[ " $LISTED " == *" $LATEST "* ]]; then
  printf '{"latest":"%s","listed":true}\n' "$LATEST" > "$OUT/result.json"
  echo "agile-graph-version-check: $LATEST is listed ($LISTED)"
  exit 0
fi

# Install the new version without running its install scripts, in a project of its own.
cd "$WORK"
npm init -y --silent > /dev/null
npm install --ignore-scripts --no-audit --no-fund --silent "@agile-graph/engine@$LATEST"
[[ "$(./node_modules/.bin/agile-graph --version)" == "$LATEST" ]] || { echo "installed engine is not $LATEST" >&2; exit 1; }
mkdir project
./node_modules/.bin/agile-graph -C project init --name version-check > /dev/null
./node_modules/.bin/agile-graph -C project mcp-tools --client cloud --hashes > "$WORK/hashes.json"
DIFF="$(node "$ROOT/scripts/agile-graph-pin-diff.mjs" "$WORK/hashes.json" "$ROOT/mcp-configs/universal/agile-graph.tool-hashes.json")"
node -e '
  const [latest, diff, hashesFile, out] = process.argv.slice(1);
  const result = { latest, listed: false, ...JSON.parse(diff), hashes: JSON.parse(require("node:fs").readFileSync(hashesFile, "utf8")) };
  require("node:fs").writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
' "$LATEST" "$DIFF" "$WORK/hashes.json" "$OUT/result.json"
echo "agile-graph-version-check: $LATEST is not listed; $DIFF"
