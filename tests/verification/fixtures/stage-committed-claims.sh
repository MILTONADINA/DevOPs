#!/usr/bin/env bash
# MR10-B only: real, owned Git fixtures. No network or operator repository use.
set -euo pipefail
for mr10b_var in $(compgen -e); do
    [[ "$mr10b_var" == GIT_* ]] && unset "$mr10b_var"
done
unset BASH_ENV ENV CDPATH
export LC_ALL=C
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_DATE='2001-01-01T00:00:00Z' GIT_COMMITTER_DATE='2001-01-01T00:00:00Z'
MR10B_ACTION="${1:-}"
MR10B_REPO="${2:-}"
case "$MR10B_REPO" in
    /*) ;;
    *) echo 'fixture requires an absolute directory' >&2; exit 64 ;;
esac
[[ -d "$MR10B_REPO" && ! -L "$MR10B_REPO" ]] || { echo 'fixture directory missing or redirected' >&2; exit 64; }
MR10B_REAL="$(cd "$MR10B_REPO" && pwd -P)"
[[ "$MR10B_REAL" == "$MR10B_REPO" ]] || { echo 'fixture path is not canonical' >&2; exit 64; }
mr10b_git() {
    git -C "$MR10B_REPO" -c user.name='MR10B owned fixture' -c user.email='fixture@example.invalid' \
        -c commit.gpgsign=false -c core.hooksPath=/dev/null -c gc.auto=0 -c maintenance.auto=false "$@"
}
if [[ "$MR10B_ACTION" == 'init' ]]; then
    [[ ! -e "$MR10B_REPO/.git" && ! -L "$MR10B_REPO/.git" ]] || { echo 'fixture already has .git' >&2; exit 64; }
    if mr10b_probe="$(git -C "$MR10B_REPO" rev-parse --is-inside-work-tree 2>&1)"; then
        echo 'fixture refuses a Git ancestor' >&2; exit 64
    elif [[ "$mr10b_probe" != *'not a git repository'* ]]; then
        echo 'fixture cannot prove Git isolation' >&2; exit 64
    fi
    mr10b_git -c init.defaultBranch=fixture init -q
    printf 'MR10B fixture only\n' > "$MR10B_REPO/.git/mr10b-owned"
else
    [[ -d "$MR10B_REPO/.git" && ! -L "$MR10B_REPO/.git" && -f "$MR10B_REPO/.git/mr10b-owned" ]] || { echo 'unowned fixture' >&2; exit 64; }
    [[ "$(cat "$MR10B_REPO/.git/mr10b-owned")" == 'MR10B fixture only' ]] || { echo 'wrong fixture owner marker' >&2; exit 64; }
fi
[[ "$(mr10b_git rev-parse --show-toplevel)" == "$MR10B_REPO" ]] || { echo 'fixture root mismatch' >&2; exit 64; }

case "$MR10B_ACTION" in
    init|target)
        mr10b_git add -A -- src specs
        mr10b_git commit -q --allow-empty -m 'Owned target content'
        MR10B_TARGET="$(mr10b_git rev-parse HEAD)"
        mr10b_git update-ref refs/remotes/origin/main "$MR10B_TARGET"
        printf 'TARGET=%s\n' "$MR10B_TARGET"
        ;;
    publish)
        mr10b_git add -A -- .workflow/proofs/committed
        mr10b_git commit -q --allow-empty -m 'Owned committed publication'
        printf 'PUBLICATION=%s\n' "$(mr10b_git rev-parse HEAD)"
        ;;
    stage)
        mr10b_git add -A -- .workflow/proofs/committed
        ;;
    orphan)
        MR10B_EMPTY="$(mr10b_git mktree < /dev/null)"
        MR10B_ORPHAN="$(mr10b_git commit-tree "$MR10B_EMPTY" -m 'Owned orphan object')"
        printf 'ORPHAN=%s\nORPHAN_KIND=%s\n' "$MR10B_ORPHAN" "$(mr10b_git cat-file -t "$MR10B_ORPHAN")"
        ;;
    pack)
        mr10b_git pack-refs --all --prune
        mr10b_git repack -adq
        ;;
    merge)
        mr10b_git checkout -qb side
        printf 'Owned side content\n' > "$MR10B_REPO/src/side.txt"
        mr10b_git add -- src/side.txt
        mr10b_git commit -q -m 'Owned side change'
        mr10b_git checkout -q fixture
        printf 'Owned first-parent content\n' > "$MR10B_REPO/src/changed.txt"
        mr10b_git add -- src/changed.txt
        mr10b_git commit -q -m 'Owned first-parent change'
        MR10B_FIRST="$(mr10b_git rev-parse HEAD)"
        mr10b_git merge -q --no-ff --no-edit side
        MR10B_TARGET="$(mr10b_git rev-parse HEAD)"
        mr10b_git update-ref refs/remotes/origin/main "$MR10B_TARGET"
        printf 'TARGET=%s\nFIRST_PARENT=%s\n' "$MR10B_TARGET" "$MR10B_FIRST"
        ;;
    gitlink)
        MR10B_OBJECT="$(mr10b_git rev-parse HEAD)"
        mr10b_git update-index --add --cacheinfo "160000,$MR10B_OBJECT,src/module"
        mr10b_git commit -q -m 'Owned gitlink target'
        MR10B_TARGET="$(mr10b_git rev-parse HEAD)"
        mr10b_git update-ref refs/remotes/origin/main "$MR10B_TARGET"
        printf 'TARGET=%s\n' "$MR10B_TARGET"
        ;;
    *) echo 'unsupported fixture action' >&2; exit 64 ;;
esac
printf 'TOPLEVEL=%s\nGIT_BIN=%s\n' "$(mr10b_git rev-parse --show-toplevel)" "$(command -v git)"
