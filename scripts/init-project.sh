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
    if [[ -L "$hook" ]]; then
        # specs/phase-2/F-skill-provenance.md REQ-F10: never write through a link.
        echo "! Left $shown_dir/pre-commit unchanged: it is a symlink, and init does not write through one. To add the DevOPs checks by hand, run"
        echo "  $HAND_CHECKS"
        echo "  from the hook it points at."
        gate="not installed: $shown_dir/pre-commit is a symlink and was left unchanged (see above)"
    elif [[ -e "$hook" ]] && ! grep -qxF "$MARKER" "$hook"; then
        echo "! Left the existing $shown_dir/pre-commit unchanged. To add the DevOPs checks by hand, run"
        echo "  $HAND_CHECKS"
        echo "  from it, without copying the '$MARKER' line (that line lets init replace the file)."
        gate="not installed: $shown_dir/pre-commit is another tool's hook and was left unchanged (see above)"
    else
        mkdir -p "$hooks_dir"
        # read -d '' keeps the whole text, final newline included; it returns 1 at EOF.
        IFS= read -r -d '' hook_text <<'HOOK' || true
#!/usr/bin/env bash
# DevOPs pre-commit hook

# Each check stops the commit when its tool is missing, unless its skip variable
# is 1; a skipped check says so (specs/release/npm-package.md REQ-3, #348).

# Secret scan of the staged change. --redact keeps a found secret out of the terminal.
if [[ "${DEVOPS_SKIP_SECRET_SCAN:-}" == 1 ]]; then
    echo "DevOPs pre-commit: secret scan skipped (DEVOPS_SKIP_SECRET_SCAN=1)." >&2
elif command -v gitleaks >/dev/null 2>&1; then
    gitleaks git --pre-commit --staged --redact --no-banner || exit 1
else
    echo "DevOPs pre-commit: the secret scan cannot run because gitleaks is not on PATH. Install gitleaks, or commit with DEVOPS_SKIP_SECRET_SCAN=1 to skip the scan." >&2
    exit 1
fi

# Local claim metadata (the committed --all selector is a separate gate).
shopt -s nullglob dotglob
claim_files=(.workflow/proofs/*.yml)
if (( ${#claim_files[@]} )); then
    if [[ "${DEVOPS_SKIP_CLAIM_CHECK:-}" == 1 ]]; then
        echo "DevOPs pre-commit: claim check skipped (DEVOPS_SKIP_CLAIM_CHECK=1)." >&2
    elif command -v devops >/dev/null 2>&1; then
        devops verify "${claim_files[@]}" --no-rerun || exit 1
    elif [[ -x node_modules/.bin/devops ]]; then
        node_modules/.bin/devops verify "${claim_files[@]}" --no-rerun || exit 1
    else
        echo "DevOPs pre-commit: the claim check cannot run because the devops command is not on PATH or in node_modules/.bin. Install it with 'npm install -D @miltonadina/devops', or commit with DEVOPS_SKIP_CLAIM_CHECK=1 to skip the check." >&2
        exit 1
    fi
fi
HOOK
        # specs/phase-2/F-skill-provenance.md REQ-F11 (#349): an existing DevOPs
        # hook that differs is backed up before it is replaced. Node runs only then.
        hook_backup=""
        if [[ -e "$hook" ]] && ! hook_backup="$(printf '%s' "$hook_text" | "${DEVOPS_NODE:-node}" "$DEVOPS_ROOT/analyzer/backup-file.mjs" "$PROJECT" "$hook" - git-hooks/pre-commit)"; then
            echo "Could not back up $shown_dir/pre-commit; left it unchanged." >&2
            exit 1
        fi
        # specs/release/npm-package.md REQ-15 (#353): record the hook in the install
        # manifest. `devops init` always passes DEVOPS_NODE; without it nothing is recorded.
        record_hook() {
            [[ -z "${DEVOPS_NODE:-}" ]] || "$DEVOPS_NODE" "$DEVOPS_ROOT/analyzer/record-hook.mjs" "$PROJECT" "$hook" "$1"
        }
        record_hook before
        printf '%s' "$hook_text" > "$hook"
        record_hook after
        [[ -z "$hook_backup" ]] || echo "↻ Replaced $shown_dir/pre-commit; the previous copy is in $hook_backup"
        chmod +x "$hook"
        echo "✓ Installed pre-commit hook"
        gate="installed at $shown_dir/pre-commit"
        # specs/release/npm-package.md REQ-8: name each check whose tool is missing.
        if command -v gitleaks >/dev/null 2>&1; then
            secret_scan="runs: gitleaks is on this shell's PATH (a git client with another PATH needs it there too)"
        else
            secret_scan="cannot run: gitleaks is not on PATH, so every commit stops until it is installed or DEVOPS_SKIP_SECRET_SCAN=1 is set"
        fi
        if command -v devops >/dev/null 2>&1 || [[ -x "$PROJECT/node_modules/.bin/devops" ]]; then
            claim_check="runs: the devops command is on this shell's PATH or in node_modules/.bin"
        else
            claim_check="cannot run: the devops command is not on PATH or in node_modules/.bin, so a commit with .workflow/proofs/*.yml claims stops until 'npm install -D @miltonadina/devops' or DEVOPS_SKIP_CLAIM_CHECK=1"
        fi
        # A linked worktree runs the hooks of the repository it belongs to.
        if [[ "$(git -C "$PROJECT" rev-parse --git-dir)" != "$(git -C "$PROJECT" rev-parse --git-common-dir)" ]]; then
            gate="$gate (shared by every worktree of this repository)"
        fi
    fi
fi

# Claude Code runs a hook script only when .claude/settings.json names it. install.ts wires the
# hooks it can (and prints each one it did not wire, with its reason, above); this line counts them.
claude_hooks=""
if [[ "$DRY_RUN" != 1 ]]; then
    shopt -s nullglob
    copied=("$PROJECT"/.claude/hooks/*.sh)
    shopt -u nullglob
    wired=0
    # ${a[@]+"${a[@]}"}: an empty array under `set -u` in macOS's bash 3.2.
    for script in ${copied[@]+"${copied[@]}"}; do
        name="$(basename "$script")"
        if grep -qsE "[ /]${name//./\\.}([\\\" ]|\$)" "$PROJECT/.claude/settings.json" "$PROJECT/.claude/settings.local.json"; then
            wired=$((wired + 1))
        fi
    done
    if (( ${#copied[@]} == 0 )); then
        claude_hooks="none copied"
    else
        claude_hooks="${#copied[@]} copied to .claude/hooks/; $wired named by .claude/settings.json or settings.local.json; $(( ${#copied[@]} - wired )) not named there (listed above; $DEVOPS_ROOT/docs/HOOKS.md says why)"
    fi
fi

echo ""
echo "Safety gates:"
echo "  pre-commit gate: $gate"
[[ -z "${secret_scan:-}" ]] || echo "  secret scan: $secret_scan"
[[ -z "${claim_check:-}" ]] || echo "  claim check: $claim_check"
[[ -z "$claude_hooks" ]] || echo "  Claude Code hooks: $claude_hooks"

echo ""
# specs/ops/analyzer-detection.md REQ-4: a dry run never claims it installed anything.
if [[ "$DRY_RUN" == 1 ]]; then
    echo "Dry run complete: nothing was written. Run without --dry-run to install."
    exit 0
fi
echo "DevOPs initialized. Open this project in your coding agent of choice."
