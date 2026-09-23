#!/usr/bin/env bash
# scripts/recover-claim-provenance.sh
#
# Fixes SHIP_BLOCKERS.md 1.1: `npm run validate:claims` reported 92 of 97
# claims failing with "git_sha does not exist in this repository". Root
# cause, confirmed 2026-09-14: these commits are NOT destroyed. GitHub
# squash-merges a PR onto the target branch and deletes the source branch,
# but GitHub's object store keeps the original (pre-squash) commits
# reachable by SHA via its API/fetch protocol for a long time after the
# branch ref is gone -- they're just unreachable from any *local* ref, so a
# normal `git fetch origin` (which only follows existing branch/tag refs)
# never pulls them back in.
#
# `git fetch origin <sha>` DOES pull an individual commit by SHA even when
# it's not reachable from any remote ref -- verified against all 52
# distinct missing SHAs in this repo, 52/52 recovered. The object then
# needs a durable ref (a plain `git fetch` only updates the ephemeral
# FETCH_HEAD, which the next fetch overwrites, leaving the object
# unreachable again and eligible for `git gc` pruning) -- this script
# anchors each recovered commit under refs/claim-provenance/<sha>, a
# dedicated namespace that doesn't collide with real branches/tags.
#
# This is a mechanical, zero-risk fix: no claim YAML is rewritten, no
# validator logic changes, nothing is force-pushed or deleted. It does NOT
# push the recovered refs to origin -- run with --push to also do that, so
# other clones (CI runners, other developers) don't have to independently
# rediscover and refetch these commits. Left as an explicit opt-in rather
# than default, since pushing new refs to the shared remote is a decision
# worth a deliberate choice, not a default of this script.
#
# Usage: scripts/recover-claim-provenance.sh [--push]

set -euo pipefail

PUSH=0
if [[ "${1:-}" == "--push" ]]; then
    PUSH=1
fi

cd "$(git rev-parse --show-toplevel)"

echo "Running validate:claims to find currently-missing git_sha values..."
MISSING_SHAS="$(npm run validate:claims --silent 2>&1 | grep "does not exist" | grep -oE '[0-9a-f]{40}' | sort -u || true)"

if [[ -z "$MISSING_SHAS" ]]; then
    echo "No missing git_sha values found -- nothing to recover."
    exit 0
fi

TOTAL=$(echo "$MISSING_SHAS" | wc -l | tr -d ' ')
echo "Found $TOTAL distinct missing SHA(s). Attempting recovery..."

recovered=0
still_missing=()
while read -r sha; do
    [[ -z "$sha" ]] && continue
    if git fetch origin "$sha" >/dev/null 2>&1; then
        git update-ref "refs/claim-provenance/$sha" "$sha"
        recovered=$((recovered + 1))
    else
        still_missing+=("$sha")
    fi
done <<< "$MISSING_SHAS"

echo "Recovered: $recovered / $TOTAL"
if [[ ${#still_missing[@]} -gt 0 ]]; then
    echo "Genuinely unrecoverable (not found on origin even by direct SHA fetch):"
    printf '  %s\n' "${still_missing[@]}"
fi

if [[ "$PUSH" -eq 1 && "$recovered" -gt 0 ]]; then
    echo "Pushing refs/claim-provenance/* to origin (--push was passed)..."
    git push origin 'refs/claim-provenance/*:refs/claim-provenance/*'
fi

echo
echo "Re-running validate:claims to show the improvement..."
npm run validate:claims --silent 2>&1 | grep -cE '^✓' | xargs -I{} echo "{} claims now pass"
