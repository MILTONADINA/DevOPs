#!/usr/bin/env bash
# hooks/universal/pre-tool/block-secrets.sh
#
# Blocks any file read or write that matches sensitive patterns.
# Fires before file_read, file_write, bash_tool, str_replace, create_file.

set -euo pipefail

PATH_ARG="${1:-}"
OPERATION="${2:-read}"

# Escapes $1 for use inside a JSON string literal: backslash, quote, and control characters
# (RFC 8259). A character loop, not ${var//pat/rep}: bash 3.2 (macOS /bin/bash) mangles quoted
# replacements. Bytes 0x80 and above pass through unchanged, as UTF-8.
json_escape() {
    local s="$1" out="" i c code hex
    for (( i = 0; i < ${#s}; i++ )); do
        c="${s:i:1}"
        case "$c" in
            "\\") out+='\\' ;;
            '"') out+='\"' ;;
            *)
                printf -v code '%d' "'$c"
                if (( code < 32 )); then
                    case "$code" in
                        8) out+='\b' ;;
                        9) out+='\t' ;;
                        10) out+='\n' ;;
                        12) out+='\f' ;;
                        13) out+='\r' ;;
                        *) printf -v hex '\\u%04x' "$code"; out+="$hex" ;;
                    esac
                else
                    out+="$c"
                fi
                ;;
        esac
    done
    printf '%s' "$out"
}

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
# Match case-insensitively: macOS and Windows file systems open .ENV or ID_RSA as
# the same file. An example file is allowed only when it is the file named (its
# basename), never because the name appears somewhere in a longer path, and never
# through a .. component (.env.example/../.env names .env).
LOWER="$(printf '%s' "$PATH_ARG" | tr '[:upper:]' '[:lower:]')"
BASE="${LOWER##*/}"
for a in "${ALLOW[@]}"; do
    if [[ "$BASE" == "$a" && "/$LOWER/" != *"/../"* ]]; then
        exit 0
    fi
done

# Check sensitive patterns
for p in "${PATTERNS[@]}"; do
    if [[ "$LOWER" == *"$p"* ]]; then
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
        # Log the attempt. The path and operation are caller-supplied, so they are escaped: a quote,
        # backslash or newline in them must not break the line or add keys (issue #426).
        mkdir -p .workflow/state
        printf '{"ts":%s,"event":"secret_block","path":"%s","operation":"%s"}\n' \
            "$(date -u +%s)" "$(json_escape "$PATH_ARG")" "$(json_escape "$OPERATION")" >> .workflow/state/events.jsonl
        exit 2
    fi
done

# Check extension blocklist
for e in "${EXT_BLOCK[@]}"; do
    if [[ "$LOWER" == *"$e" ]]; then
        echo "DevOPs SECRET BLOCK: refused to $OPERATION $PATH_ARG (blocked extension: $e)" >&2
        exit 2
    fi
done

exit 0
