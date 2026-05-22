#!/usr/bin/env bash
# hooks/universal/pre-tool/block-secrets.sh
#
# Blocks any file read or write that matches sensitive patterns.
# Fires before file_read, file_write, bash_tool, str_replace, create_file.

set -euo pipefail

PATH_ARG="${1:-}"
OPERATION="${2:-read}"

# Sensitive path patterns (file basenames or path fragments)
PATTERNS=(
    ".env"
    ".env.local"
    ".env.production"
    ".env.staging"
    "id_rsa"
    "id_ed25519"
    "id_ecdsa"
    "id_dsa"
    ".ssh/"
    ".aws/credentials"
    ".aws/config"
    ".gnupg/"
    ".kube/config"
    ".docker/config.json"
    "credentials.json"
    "service-account"
    "/etc/passwd"
    "/etc/shadow"
    "/etc/sudoers"
    "secrets.yml"
    "secrets.yaml"
)

# Extension blocklist
EXT_BLOCK=(
    ".pem"
    ".key"
    ".crt"
    ".p12"
    ".pfx"
    ".keystore"
    ".jks"
)

# Allowlist (these are OK to access even if they match patterns)
ALLOW=(
    ".env.example"
    ".env.template"
    ".env.sample"
)

# Check allow list first
for a in "${ALLOW[@]}"; do
    if [[ "$PATH_ARG" == *"$a"* ]]; then
        exit 0
    fi
done

# Check sensitive patterns
for p in "${PATTERNS[@]}"; do
    if [[ "$PATH_ARG" == *"$p"* ]]; then
        cat >&2 <<EOF
DevOPs SECRET BLOCK: refused to $OPERATION $PATH_ARG
This file matches sensitive pattern: $p

If you legitimately need to access secrets, use a vault tool:
  - Doppler: doppler secrets get <name>
  - 1Password CLI: op read "op://vault/item/field"
  - HashiCorp Vault: vault kv get <path>
  - Infisical: infisical secrets get <name>

Never commit secrets to git. Never paste them into chat. Use the vault.
EOF
        # Log the attempt
        mkdir -p .workflow/state
        echo "{\"ts\":$(date -u +%s),\"event\":\"secret_block\",\"path\":\"$PATH_ARG\",\"operation\":\"$OPERATION\"}" >> .workflow/state/events.jsonl
        exit 2
    fi
done

# Check extension blocklist
for e in "${EXT_BLOCK[@]}"; do
    if [[ "$PATH_ARG" == *"$e" ]]; then
        echo "DevOPs SECRET BLOCK: refused to $OPERATION $PATH_ARG (blocked extension: $e)" >&2
        exit 2
    fi
done

exit 0
