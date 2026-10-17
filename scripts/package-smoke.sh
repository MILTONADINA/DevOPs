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

# 1. The tarball holds the product and none of this repository's own records (REQ-4).
TARBALL="$WORK/$(npm pack "$ROOT" --pack-destination "$WORK" --silent)"
CONTENTS="$WORK/contents.txt"
tar -tzf "$TARBALL" | sed 's#^package/##' | sort > "$CONTENTS"
for needed in package.json AGENTS.md CLAUDE.md LICENSE README.md \
  scripts/devops-cli.js scripts/devops-analyze.js scripts/devops-paths.js scripts/init-project.sh \
  analyzer/scan.ts analyzer/install.ts verification/claim-validator.ts governance/skill-manifest.yml \
  hooks/universal/pre-tool/graph-command-classifier.mjs; do
  grep -qxF "$needed" "$CONTENTS" || fail "tarball is missing $needed"
done
# Repository records, tooling and the graph pipeline's pieces.
EXCLUDED='^(\.workflow/|specs/|tests/|runtime/|\.github/|docs/(handoff/|LAUNCH_READINESS\.md|GAP_61_COVERAGE_MATRIX\.md|TESTING\.md|RELEASING\.md|runbooks/|threat-models/)|governance/(graph/|test-floors\.json|claim-retirements\.json|traceability-baseline\.json|required-checks\.yml|enforcement-baseline\.json|decisions/|changelog/)|hooks/universal/session-start/graph-preflight\.sh|slash-commands/universal/(sprint|sprint-approve|graph-halt|graph-resume)\.md)'
if grep -E "$EXCLUDED" "$CONTENTS"; then
  fail "tarball ships repository-internal files (listed above)"
fi
# npm does not ignore .env files, so one inside any shipped folder would be published
# (runtime/.env.example is not shipped, so no example file is allowed for here).
if grep -E '(^|/)\.env' "$CONTENTS"; then
  fail "tarball ships a .env file (listed above)"
fi
# Only the command entry points and their helpers ship from scripts/; CI tooling stays out.
SHIPPED_SCRIPTS='^scripts/(devops-cli\.js|devops-analyze\.js|devops-paths\.js|init-project\.sh|post-install\.sh)$'
if grep '^scripts/' "$CONTENTS" | grep -vE "$SHIPPED_SCRIPTS"; then
  fail "tarball ships scripts that are not command entry points (listed above)"
fi
echo "package-smoke: tarball $(basename "$TARBALL"), $(wc -l < "$CONTENTS" | tr -d ' ') files"

# 2. Install it into an empty project with runtime dependencies only.
APP="$WORK/app"
mkdir -p "$APP"
cp -R "$ROOT/tests/fixtures/analyzer/nextjs-project/." "$APP/"
git init -q "$APP"   # a real repository for `devops init`
cd "$APP"
npm install --omit=dev --no-audit --no-fund --silent "$TARBALL"
INSTALLED="$APP/node_modules/$NAME"

# 3. Every shipped skill matches its signed manifest entry, not only the ones this
# project is recommended: a skill edited since it was signed fails here (re-sign with
# release-sign.yml). cosign verification of the signatures runs at release time.
node --input-type=module - "$INSTALLED" <<'NODE' || fail "a shipped skill does not match its signed manifest entry"
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
const root = process.argv[2];
const manifest = YAML.parse(readFileSync(path.join(root, 'governance/skill-manifest.yml'), 'utf8'));
const entries = manifest?.skills;
if (!Array.isArray(entries) || entries.length === 0) throw new Error('no skills in the manifest');
let bad = 0;
for (const entry of entries) {
  const skill = path.join(root, entry.path);
  const problems = [];
  if (!existsSync(skill)) problems.push('missing skill');
  else if (createHash('sha256').update(readFileSync(skill)).digest('hex') !== entry.sha256) problems.push('hash differs from the manifest');
  for (const companion of [entry.sig_path, entry.bundle_path]) {
    if (typeof companion !== 'string' || !existsSync(path.join(root, companion))) problems.push(`missing ${companion}`);
  }
  if (problems.length) { bad++; console.error(`stale or unsigned: ${entry.path}: ${problems.join(', ')}`); }
}
if (bad) process.exit(1);
console.log(`package-smoke: ${entries.length} shipped skills match their signed manifest entries`);
NODE

# 4. Every command runs from the install, with no DEVOPS_ROOT and an empty HOME, so
# nothing can come from a checkout or ~/DevOPs.
export HOME="$WORK/home"
mkdir -p "$HOME"
unset DEVOPS_ROOT
BIN="$APP/node_modules/.bin"

[[ "$("$BIN/devops" version)" == "$VERSION" ]] || fail "devops version does not print $VERSION"
HELP="$("$BIN/devops" help)"
grep -qxF "DevOPs root: $INSTALLED" <<< "$HELP" || fail "devops help does not report the installed package as its root"

"$BIN/devops-analyze" > "$WORK/analyze.log" || { cat "$WORK/analyze.log"; fail "devops-analyze failed"; }
[[ -f .workflow/profile.yml ]] || fail "devops-analyze wrote no .workflow/profile.yml"

# --dry-run verifies each recommended skill again and copies nothing.
"$BIN/devops" init --dry-run > "$WORK/init.log" || { cat "$WORK/init.log"; fail "devops init --dry-run failed"; }
[[ ! -e .git/hooks/pre-commit ]] || fail "devops init --dry-run wrote a git hook"

# A real init writes the gate where Git runs hooks and says so in its summary
# (specs/release/npm-package.md REQ-3, REQ-8).
"$BIN/devops" init > "$WORK/init-real.log" || { cat "$WORK/init-real.log"; fail "devops init failed"; }
grep -qxF "  pre-commit gate: installed at .git/hooks/pre-commit" "$WORK/init-real.log" || { cat "$WORK/init-real.log"; fail "devops init did not report the installed gate"; }
[[ -x .git/hooks/pre-commit ]] || fail "devops init did not write an executable .git/hooks/pre-commit"
grep -q "^  Claude Code hooks: " "$WORK/init-real.log" || fail "devops init did not report the Claude Code hooks"

if "$BIN/devops" toString > /dev/null 2>&1; then fail "devops accepted an unknown command"; fi

echo "package-smoke: $NAME@$VERSION installs and runs: version, help, analyze, init --dry-run, init"
