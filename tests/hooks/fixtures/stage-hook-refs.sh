#!/usr/bin/env bash
# MR3 only: create synthetic branch/tag identities inside a fresh fixture repo.
# No push, remote, checkout, working-tree commit or host config mutation occurs.
set -euo pipefail
for mr3_var in $(compgen -e); do
    [[ "$mr3_var" == GIT_* ]] && unset "$mr3_var"
done
export LC_ALL=C
MR3_REPO="${1:-}"
case "$MR3_REPO" in
    /*) ;;
    *)
        echo 'fixture requires an absolute directory' >&2
        exit 64
        ;;
esac
[[ -d "$MR3_REPO" && ! -e "$MR3_REPO/.git" ]] || { echo 'fixture requires a fresh directory without .git' >&2; exit 64; }
if mr3_probe="$(git -C "$MR3_REPO" rev-parse --is-inside-work-tree 2>&1)"; then
    echo 'fixture refuses any existing Git ancestor' >&2
    exit 64
elif [[ "$mr3_probe" != *'not a git repository'* ]]; then
    echo 'fixture cannot establish Git isolation' >&2
    exit 64
fi
git -C "$MR3_REPO" init -q
[[ "$(git -C "$MR3_REPO" rev-parse --show-toplevel)" == "$MR3_REPO" ]] || exit 64
mr3_tree="$(git -C "$MR3_REPO" mktree < /dev/null)"
mr3_commit="$(git -C "$MR3_REPO" -c user.name='MR3 synthetic fixture' -c user.email='fixture@example.invalid' -c commit.gpgsign=false commit-tree "$mr3_tree" -m 'Synthetic hook lookup object')"
for mr3_branch in branch-only both feature; do
    git -C "$MR3_REPO" update-ref "refs/heads/$mr3_branch" "$mr3_commit"
done
for mr3_tag in tag-only both release-candidate v1.0.0; do
    git -C "$MR3_REPO" update-ref "refs/tags/$mr3_tag" "$mr3_commit"
done
mkdir -p "$MR3_REPO/directory with spaces"
printf 'TOPLEVEL=%s\nGIT_BIN=%s\n' "$(git -C "$MR3_REPO" rev-parse --show-toplevel)" "$(command -v git)"
printf 'REFS_BEGIN\n'
git -C "$MR3_REPO" for-each-ref --format='%(refname)' refs/heads refs/tags
printf 'REFS_END\n'
