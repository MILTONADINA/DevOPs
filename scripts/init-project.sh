#!/usr/bin/env bash
# scripts/init-project.sh
#
# Install DevOPs components into the current project per the recommendations
# in .workflow/profile.yml. Run after `devops analyze`; `devops init` runs this script.

set -euo pipefail
# specs/release/npm-package.md REQ-2: default to the checkout or package this script
# belongs to. `devops init` passes DEVOPS_ROOT, DEVOPS_NODE and DEVOPS_TSX.
DEVOPS_ROOT="${DEVOPS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The project to set up: the installer's --target, or the current directory. The
# profile check and the git hook use the same project the installer writes to.
PROJECT="."
DRY_RUN=0
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[$i]}" in
        --dry-run) DRY_RUN=1 ;;
        --target=*) PROJECT="${args[$i]#--target=}" ;;
        --target) if (( i + 1 < ${#args[@]} )); then PROJECT="${args[$((i + 1))]}"; fi ;;
    esac
done

if [[ ! -f "$PROJECT/.workflow/profile.yml" ]]; then
    echo "No .workflow/profile.yml found in $PROJECT. Run 'devops analyze' there first." >&2
    exit 1
fi

if [[ -n "${DEVOPS_TSX:-}" ]]; then
    "${DEVOPS_NODE:-node}" "$DEVOPS_TSX" "$DEVOPS_ROOT/analyzer/install.ts" "$@"
elif command -v tsx >/dev/null 2>&1; then
    tsx "$DEVOPS_ROOT/analyzer/install.ts" "$@"
else
    node --experimental-strip-types "$DEVOPS_ROOT/analyzer/install.ts" "$@"
fi

# Set up a git pre-commit hook (specs/release/npm-package.md REQ-3 and REQ-8). Git is
# asked where it runs this project's hooks: `rev-parse --git-path hooks` follows
# worktrees and submodules, where .git is a file. A folder set with core.hooksPath is the
# project's own (often tracked) or shared with other repositories, so init never writes
# into it. An existing hook is never replaced: it may be the project's own, or another
# tool's. A dry run writes nothing. Every outcome ends up in the summary below.
MARKER="# DevOPs pre-commit hook"
HAND_CHECKS="'gitleaks git --pre-commit --staged --redact' and 'devops verify <claim files> --no-rerun'"
gate=""
hooks_dir=""
if ! command -v git >/dev/null 2>&1; then
    gate="not installed: git is not on PATH"
elif ! git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1; then
    if [[ "$PROJECT" == "." ]]; then where="this folder"; else where="$PROJECT"; fi
    gate="not installed: $where is not a git repository"
else
    hooks_path_setting="$(git -C "$PROJECT" config --get core.hooksPath 2>/dev/null || true)"
    if [[ -n "$hooks_path_setting" ]]; then
        gate="not installed: core.hooksPath is '$hooks_path_setting', so Git runs hooks from there, and init does not write into that folder. Add $HAND_CHECKS to its pre-commit"
    else
        hooks_dir="$(git -C "$PROJECT" rev-parse --git-path hooks)"
        # Relative output is relative to the project (-C); show it that way too.
        shown_dir="${hooks_dir#./}"
        [[ "$hooks_dir" == /* ]] || hooks_dir="$PROJECT/$hooks_dir"
    fi
fi
if [[ -n "$hooks_dir" && "$DRY_RUN" == 1 ]]; then
    echo "dry-run: would install $shown_dir/pre-commit unless another tool's hook is there"
    gate="dry-run: would install $shown_dir/pre-commit"
elif [[ -n "$hooks_dir" ]]; then
    hook="$hooks_dir/pre-commit"
    if [[ -e "$hook" ]] && ! grep -qxF "$MARKER" "$hook"; then
        echo "! Left the existing $shown_dir/pre-commit unchanged. To add the DevOPs checks by hand, run"
        echo "  $HAND_CHECKS"
        echo "  from it, without copying the '$MARKER' line (that line lets init replace the file)."
        gate="not installed: $shown_dir/pre-commit is another tool's hook and was left unchanged (see above)"
    else
        mkdir -p "$hooks_dir"
        cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
# DevOPs pre-commit hook

# Secret scan of the staged change. --redact keeps a found secret out of the terminal.
if command -v gitleaks >/dev/null 2>&1; then
    gitleaks git --pre-commit --staged --redact --no-banner || exit 1
fi

# Local claim metadata (the committed --all selector is a separate gate).
shopt -s nullglob dotglob
claim_files=(.workflow/proofs/*.yml)
if (( ${#claim_files[@]} )); then
    if command -v devops >/dev/null 2>&1; then
        devops verify "${claim_files[@]}" --no-rerun || exit 1
    elif [[ -x node_modules/.bin/devops ]]; then
        node_modules/.bin/devops verify "${claim_files[@]}" --no-rerun || exit 1
    fi
fi
HOOK
        chmod +x "$hook"
        echo "✓ Installed pre-commit hook"
        gate="installed at $shown_dir/pre-commit"
        # A linked worktree runs the hooks of the repository it belongs to.
        if [[ "$(git -C "$PROJECT" rev-parse --git-dir)" != "$(git -C "$PROJECT" rev-parse --git-common-dir)" ]]; then
            gate="$gate (shared by every worktree of this repository)"
        fi
    fi
fi

# Claude Code runs a hook script only when .claude/settings.json (or settings.local.json)
# names it; init copies the scripts but does not edit those files.
claude_hooks=""
if [[ "$DRY_RUN" != 1 ]]; then
    shopt -s nullglob
    copied=("$PROJECT"/.claude/hooks/*.sh)
    shopt -u nullglob
    unwired=()
    # ${a[@]+"${a[@]}"}: an empty array under `set -u` in macOS's bash 3.2.
    for script in ${copied[@]+"${copied[@]}"}; do
        name="$(basename "$script")"
        if ! grep -qsF "$name" "$PROJECT/.claude/settings.json" "$PROJECT/.claude/settings.local.json"; then
            unwired+=("$name")
        fi
    done
    if (( ${#copied[@]} == 0 )); then
        claude_hooks="none copied"
    elif (( ${#unwired[@]} == 0 )); then
        claude_hooks="${#copied[@]} copied to .claude/hooks/, and Claude Code's settings reference each"
    else
        claude_hooks="${#copied[@]} copied to .claude/hooks/; ${#unwired[@]} not referenced by .claude/settings.json, so Claude Code does not run them: ${unwired[*]}. $DEVOPS_ROOT/docs/HOOKS.md shows how to wire them"
    fi
fi

echo ""
echo "Safety gates:"
echo "  pre-commit gate: $gate"
[[ -z "$claude_hooks" ]] || echo "  Claude Code hooks: $claude_hooks"

echo ""
# specs/ops/analyzer-detection.md REQ-4: a dry run never claims it installed anything.
if [[ "$DRY_RUN" == 1 ]]; then
    echo "Dry run complete: nothing was written. Run without --dry-run to install."
    exit 0
fi
echo "DevOPs initialized. Open this project in your coding agent of choice."
echo ""
echo "First steps in the agent:"
echo "  1. Read constitution/PRINCIPLES.md (auto-loaded on session start)"
echo "  2. Write your first spec in /specs/"
echo "  3. Run /ears-spec <feature-name> to convert prose to EARS"
