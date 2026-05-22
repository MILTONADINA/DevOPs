#!/usr/bin/env bash
# hooks/universal/post-tool/gitleaks-scan.sh
#
# After any file write, run gitleaks against the changed file to catch
# accidentally committed secrets. Hard-fails if secrets are found.

set -euo pipefail

CHANGED_FILE="${1:-}"

if [[ -z "$CHANGED_FILE" || ! -f "$CHANGED_FILE" ]]; then
    exit 0
fi

# Skip if gitleaks is not installed (warn once per session)
if ! command -v gitleaks >/dev/null 2>&1; then
    MARKER=".workflow/state/.gitleaks-missing-warned"
    if [[ ! -f "$MARKER" ]]; then
        echo "⚠  gitleaks not installed. Secret scanning skipped." >&2
        echo "   Install: brew install gitleaks  OR  go install github.com/gitleaks/gitleaks/v8@latest" >&2
        mkdir -p .workflow/state
        touch "$MARKER"
    fi
    exit 0
fi

# Run gitleaks on the single file
output=$(gitleaks detect --no-git --source "$CHANGED_FILE" --no-banner 2>&1 || true)
exit_code=$?

if echo "$output" | grep -q "leaks found:" && ! echo "$output" | grep -q "leaks found: 0"; then
    cat >&2 <<EOF
╔═══════════════════════════════════════════════════════════════════╗
║  DevOPs SECRET DETECTED IN $CHANGED_FILE                          ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Gitleaks found secret(s) in the file just written.               ║
║  This file MUST be cleaned before commit.                         ║
║                                                                   ║
$(echo "$output" | head -20 | sed 's/^/║  /')
║                                                                   ║
║  Required actions:                                                ║
║    1. Remove the secret from the file                             ║
║    2. Rotate the secret if it was real                            ║
║    3. Move the secret to your vault (Doppler, 1Password, etc.)    ║
║    4. Reference it via environment variable                       ║
╚═══════════════════════════════════════════════════════════════════╝
EOF
    mkdir -p .workflow/state
    echo "{\"ts\":$(date -u +%s),\"event\":\"secret_detected\",\"file\":\"$CHANGED_FILE\"}" >> .workflow/state/events.jsonl
    exit 2
fi

exit 0
