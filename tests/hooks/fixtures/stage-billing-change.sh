#!/usr/bin/env bash
# tests/hooks/fixtures/stage-billing-change.sh
#
# Builds a REAL, throwaway git repository with stratum/src/billing/pricing.ts
# genuinely staged (present in `git diff --cached --name-only`), so case (f)
# of tests/hooks/deploy-gate.test.mjs commits a real billing-path change.
# The billing four-eyes check was retired on 2026-09-26, so the current hook
# lets it through; run against the pre-retirement hook (DEPLOY_GATE_HOOK),
# the same test must still see it blocked. An empty or non-git fixture
# would give the old hook nothing to match, so both hooks would exit 0 and
# the test would pass vacuously. No commit is made (or needed): `git add`
# and `git diff --cached` work against an unborn HEAD and need no identity
# config.
#
# Usage: bash stage-billing-change.sh <absolute-tmpdir>
#
# SAFETY: called only as `spawnSync('bash', [thisPath, tmpdir])` from
# deploy-gate.test.mjs -- never hand-typed, and never after a `cd` (see
# .workflow/state/approvals.jsonl's `orchestrator_incident`: an unguarded
# `cd` in a scratch script once let a bare `git` run against the live
# checkout and sweep real uncommitted work into a stray commit). Every git
# call here is `git -C "$REPO"`, and the guard below refuses to run at all
# unless $1 is an absolute path to an existing directory that git confirms
# is outside every repository, so git init can never nest a repository
# inside this checkout or any other real repo.
set -euo pipefail

# An inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE (git exports it to
# commit hooks) or any other GIT_* variable would redirect the git calls
# below away from $REPO, whatever -C says. Clear them all.
for var in $(compgen -e); do
    [[ "$var" == GIT_* ]] && unset "$var"
done

REPO="${1:-}"
case "$REPO" in
    /*) ;;
    *)
        echo "stage-billing-change.sh: \$1 must be an absolute path (got: '$REPO')" >&2
        exit 64
        ;;
esac
if [[ ! -d "$REPO" ]]; then
    echo "stage-billing-change.sh: \$1 must be an existing directory (got: '$REPO')" >&2
    exit 64
fi
if [[ -e "$REPO/.git" ]]; then
    echo "stage-billing-change.sh: \$1 already has a .git -- refusing to reuse a non-fresh directory ('$REPO')" >&2
    exit 64
fi
# Refuse unless git itself says $REPO is outside every repository. A zero
# exit means it is inside one (a working tree, or a .git directory); any
# other failure, such as a parent repository owned by someone else, is not
# proof of "outside", so it is refused too.
if probe="$(git -C "$REPO" rev-parse --is-inside-work-tree 2>&1)"; then
    echo "stage-billing-change.sh: \$1 is inside an existing git repository -- refusing ('$REPO')" >&2
    exit 64
elif [[ "$probe" != *"not a git repository"* ]]; then
    echo "stage-billing-change.sh: cannot confirm \$1 is outside every git repository -- refusing ('$REPO'): $probe" >&2
    exit 64
fi

git -C "$REPO" init -q

mkdir -p "$REPO/stratum/src/billing"
cat > "$REPO/stratum/src/billing/pricing.ts" <<'EOF'
// Fixture-only file for tests/hooks/deploy-gate.test.mjs case (f).
// Not real pricing code -- it only needs to match the stratum/src/billing/
// glob of the retired BILLING_PATH_PATTERNS (pre-retirement hook).
export const FIXTURE_PLACEHOLDER = true;
EOF

git -C "$REPO" add -- stratum/src/billing/pricing.ts

# Machine-readable proof, printed to stdout, that the test asserts on BEFORE
# ever invoking the hook -- this is what makes case (f)'s red result
# non-vacuous (SAFETY RULE 3): the exact cwd the hook will run in genuinely
# has the exact path staged.
echo "TOPLEVEL=$(git -C "$REPO" rev-parse --show-toplevel)"
echo "STAGED_BEGIN"
git -C "$REPO" diff --cached --name-only
echo "STAGED_END"
