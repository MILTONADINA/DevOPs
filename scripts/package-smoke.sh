#!/usr/bin/env bash
# scripts/package-smoke.sh
#
# Pack the npm package, install the tarball into an empty project the way a user
# would, and run every command (specs/release/npm-package.md REQ-6). CI runs this on
# every pull request and again before a release publishes. Not shipped in the package.
#
# Usage: bash scripts/package-smoke.sh            (from the repository root)

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Resolved (pwd -P): on macOS mktemp gives /var/..., which Node reports as /private/var/...
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "package-smoke: FAIL: $*" >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="$(node -p "require('$ROOT/package.json').name")"

# 1. The tarball holds the product and none of this repository's own records.
TARBALL="$WORK/$(npm pack "$ROOT" --pack-destination "$WORK" --silent)"
CONTENTS="$WORK/contents.txt"
tar -tzf "$TARBALL" | sed 's#^package/##' | sort > "$CONTENTS"
for needed in package.json AGENTS.md CLAUDE.md LICENSE README.md \
  scripts/devops-cli.js scripts/devops-analyze.js scripts/devops-paths.js scripts/init-project.sh \
  analyzer/scan.ts analyzer/install.ts verification/claim-validator.ts governance/skill-manifest.yml \
  hooks/universal/pre-tool/graph-command-classifier.mjs; do
  grep -qxF "$needed" "$CONTENTS" || fail "tarball is missing $needed"
done
if grep -E '^(\.workflow/|specs/|tests/|runtime/|docs/handoff/|governance/graph/|scripts/graph-|\.env)' "$CONTENTS"; then
  fail "tarball ships repository-internal files (listed above)"
fi
grep -qxF 'hooks/universal/session-start/graph-preflight.sh' "$CONTENTS" && fail "tarball ships the graph preflight hook"
echo "package-smoke: tarball $(basename "$TARBALL"), $(wc -l < "$CONTENTS" | tr -d ' ') files"

# 2. Install it into an empty project with runtime dependencies only.
APP="$WORK/app"
mkdir -p "$APP"
cp -R "$ROOT/tests/fixtures/analyzer/nextjs-project/." "$APP/"
mkdir "$APP/.git"   # a repository shape for `devops init`; no git command runs here
cd "$APP"
npm install --omit=dev --no-audit --no-fund --silent "$TARBALL"
INSTALLED="$APP/node_modules/$NAME"

# 3. Every command runs from the install, with no DEVOPS_ROOT and an empty HOME, so
# nothing can come from a checkout or ~/DevOPs.
export HOME="$WORK/home"
mkdir -p "$HOME"
unset DEVOPS_ROOT
BIN="$APP/node_modules/.bin"

[[ "$("$BIN/devops" version)" == "$VERSION" ]] || fail "devops version does not print $VERSION"
"$BIN/devops" help | grep -qxF "DevOPs root: $INSTALLED" || fail "devops help does not report the installed package as its root"

"$BIN/devops-analyze" > "$WORK/analyze.log" || { cat "$WORK/analyze.log"; fail "devops-analyze failed"; }
[[ -f .workflow/profile.yml ]] || fail "devops-analyze wrote no .workflow/profile.yml"

# --dry-run verifies every recommended skill against the signed manifest and copies
# nothing, so a skill edited since it was signed fails here (run release-sign.yml).
"$BIN/devops" init --dry-run > "$WORK/init.log" || { cat "$WORK/init.log"; fail "devops init --dry-run failed"; }
[[ ! -e .git/hooks/pre-commit ]] || fail "devops init --dry-run wrote a git hook"

if "$BIN/devops" toString > /dev/null 2>&1; then fail "devops accepted an unknown command"; fi

echo "package-smoke: $NAME@$VERSION installs and runs: version, help, analyze, init --dry-run"
