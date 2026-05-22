#!/usr/bin/env bash
# scripts/init-project.sh
#
# Install DevOPs components into the current project per the recommendations
# in .workflow/profile.yml. Run after analyze.sh.

set -euo pipefail
DEVOPS_ROOT="${DEVOPS_ROOT:-$HOME/DevOPs}"

if [[ ! -f .workflow/profile.yml ]]; then
    echo "No .workflow/profile.yml found. Run analyze.sh first." >&2
    exit 1
fi

if command -v tsx >/dev/null 2>&1; then
    tsx "$DEVOPS_ROOT/analyzer/install.ts"
else
    node --experimental-strip-types "$DEVOPS_ROOT/analyzer/install.ts"
fi

# Set up git hooks if this is a git repo
if [[ -d .git ]]; then
    mkdir -p .git/hooks
    cat > .git/hooks/pre-commit <<'HOOK'
#!/usr/bin/env bash
# DevOPs pre-commit hook
DEVOPS_ROOT="${DEVOPS_ROOT:-$HOME/DevOPs}"

# Gitleaks scan
if command -v gitleaks >/dev/null 2>&1; then
    gitleaks protect --staged --no-banner || exit 1
fi

# Claim validator on any modified proof files
if ls .workflow/proofs/*.yml 2>/dev/null >/dev/null; then
    if command -v tsx >/dev/null 2>&1; then
        tsx "$DEVOPS_ROOT/verification/claim-validator.ts" --all --no-rerun || exit 1
    fi
fi
HOOK
    chmod +x .git/hooks/pre-commit
    echo "✓ Installed pre-commit hook"
fi

echo ""
echo "DevOPs initialized. Open this project in your coding agent of choice."
echo ""
echo "First steps in the agent:"
echo "  1. Read constitution/PRINCIPLES.md (auto-loaded on session start)"
echo "  2. Write your first spec in /specs/"
echo "  3. Run /ears-spec <feature-name> to convert prose to EARS"
