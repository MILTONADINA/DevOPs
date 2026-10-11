#!/usr/bin/env bash
# scripts/init-project.sh
#
# Install DevOPs components into the current project per the recommendations
# in .workflow/profile.yml. Run after analyze.sh.

set -euo pipefail
# specs/release/npm-package.md REQ-2: default to the checkout or package this script
# belongs to. `devops init` passes DEVOPS_ROOT, DEVOPS_NODE and DEVOPS_TSX.
DEVOPS_ROOT="${DEVOPS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [[ ! -f .workflow/profile.yml ]]; then
    echo "No .workflow/profile.yml found. Run 'devops analyze' first." >&2
    exit 1
fi

if [[ -n "${DEVOPS_TSX:-}" ]]; then
    "${DEVOPS_NODE:-node}" "$DEVOPS_TSX" "$DEVOPS_ROOT/analyzer/install.ts" "$@"
elif command -v tsx >/dev/null 2>&1; then
    tsx "$DEVOPS_ROOT/analyzer/install.ts" "$@"
else
    node --experimental-strip-types "$DEVOPS_ROOT/analyzer/install.ts" "$@"
fi

# Set up a git pre-commit hook if this is a git repo. An existing hook is never
# replaced: it may be the project's own, or another tool's. A dry run writes nothing.
DRY_RUN=0
for arg in "$@"; do [[ "$arg" == "--dry-run" ]] && DRY_RUN=1; done
MARKER="# DevOPs pre-commit hook"
if [[ -d .git && "$DRY_RUN" == 1 ]]; then
    echo "dry-run: would install .git/hooks/pre-commit unless another tool's hook is there"
elif [[ -d .git ]]; then
    hook=.git/hooks/pre-commit
    if [[ -e "$hook" ]] && ! grep -qxF "$MARKER" "$hook"; then
        echo "! Left the existing .git/hooks/pre-commit unchanged; add the DevOPs checks to it by hand (see docs/SECURITY.md)."
    else
        mkdir -p .git/hooks
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
    fi
fi

echo ""
echo "DevOPs initialized. Open this project in your coding agent of choice."
echo ""
echo "First steps in the agent:"
echo "  1. Read constitution/PRINCIPLES.md (auto-loaded on session start)"
echo "  2. Write your first spec in /specs/"
echo "  3. Run /ears-spec <feature-name> to convert prose to EARS"
