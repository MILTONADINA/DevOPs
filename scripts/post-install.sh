#!/usr/bin/env bash
# scripts/post-install.sh
#
# Runs after `/plugin install devops` in Claude Code. Adds the universal
# components and starts the session-start hook chain.

set -euo pipefail

echo "DevOPs plugin installed."
echo "Loading constitution and hooks on next session start."

if [[ -d .git ]] && [[ ! -f .workflow/profile.yml ]]; then
    echo ""
    echo "This project does not have a DevOPs profile yet."
    echo "Recommended: run 'devops analyze' to auto-detect stack and configure."
fi
