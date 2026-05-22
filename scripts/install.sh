#!/usr/bin/env bash
# scripts/install.sh
#
# Install DevOPs globally. After this, the analyzer can be invoked from any
# project directory via `~/DevOPs/scripts/analyze.sh`.

set -euo pipefail

DEVOPS_ROOT="${DEVOPS_ROOT:-$HOME/DevOPs}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Installing DevOPs from $REPO_ROOT to $DEVOPS_ROOT"

if [[ "$REPO_ROOT" != "$DEVOPS_ROOT" ]]; then
    if [[ -d "$DEVOPS_ROOT" ]]; then
        echo "DevOPs root already exists at $DEVOPS_ROOT"
        echo "To overwrite, remove it first: rm -rf $DEVOPS_ROOT"
        exit 1
    fi
    cp -R "$REPO_ROOT" "$DEVOPS_ROOT"
fi

# Make scripts and hooks executable
find "$DEVOPS_ROOT/hooks" -name "*.sh" -exec chmod +x {} \;
find "$DEVOPS_ROOT/scripts" -name "*.sh" -exec chmod +x {} \;

# Add to PATH (for the current shell; user adds to their rc file for persistence)
echo ""
echo "✓ DevOPs installed to $DEVOPS_ROOT"
echo ""
echo "To make available everywhere, add to your shell rc (~/.bashrc, ~/.zshrc):"
echo ""
echo "  export DEVOPS_ROOT=\"$DEVOPS_ROOT\""
echo "  export PATH=\"\$DEVOPS_ROOT/scripts:\$PATH\""
echo ""
echo "Then in any project:"
echo "  cd ~/my-project"
echo "  analyze.sh        # detects stack and produces .workflow/profile.yml"
echo "  init-project.sh   # installs hooks, skills, subagents into .claude/"
echo ""
