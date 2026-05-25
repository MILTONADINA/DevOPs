#!/usr/bin/env bash
# hooks/universal/session-end/rotate-session-key.sh
#
# Phase 2 Area C / REQ-C3 (rotation enforcement) — session-end hook that
# regenerates .workflow/state/session-key, invalidating the prior session's
# HMAC keys.
#
# Consequence: any external-content marker produced with the previous
# session's key fails HMAC verification on the next session
# (cross-session replay infeasible). Also invalidates outstanding approval
# tokens from C.07 — by design (one-shot, session-scoped).
#
# Closes threat model C Open Issue #1 (session-key rotation gap).
#
# Emits a session_key.rotated event to .workflow/state/events.jsonl.

set -euo pipefail

SESSION_KEY_PATH=".workflow/state/session-key"
EVENTS_LOG=".workflow/state/events.jsonl"

mkdir -p "$(dirname "${SESSION_KEY_PATH}")"

# 16 bytes of crypto.randomBytes equivalent → hex
NEW_KEY=$(python3 -c "import secrets; print(secrets.token_hex(16))")

# Capture old key fingerprint for audit (first 8 chars of the hex — enough
# to confirm rotation without exposing the full key)
OLD_PREFIX=""
if [ -f "${SESSION_KEY_PATH}" ]; then
  OLD_PREFIX=$(head -c 8 "${SESSION_KEY_PATH}" 2>/dev/null || echo "")
fi

# Write new key with restrictive permissions
printf '%s' "${NEW_KEY}" > "${SESSION_KEY_PATH}"
chmod 0600 "${SESSION_KEY_PATH}" 2>/dev/null || true  # best-effort on Windows

NEW_PREFIX=$(echo "${NEW_KEY}" | head -c 8)

# Emit rotation event
printf '{"ts":"%s","event":"session_key.rotated","old_prefix":"%s","new_prefix":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${OLD_PREFIX}" "${NEW_PREFIX}" >> "${EVENTS_LOG}"

echo "session-key rotated (old=${OLD_PREFIX}... → new=${NEW_PREFIX}...)"
exit 0
