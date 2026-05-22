#!/usr/bin/env bash
# hooks/universal/post-tool/auto-format.sh
#
# After any file write, auto-format using the project's configured formatter.
# Detects the formatter from project manifests.

set -euo pipefail

CHANGED_FILE="${1:-}"

if [[ -z "$CHANGED_FILE" || ! -f "$CHANGED_FILE" ]]; then
    exit 0
fi

# Detect formatter by file extension and project manifests
ext="${CHANGED_FILE##*.}"

case "$ext" in
    ts|tsx|js|jsx|mjs|cjs)
        if command -v biome >/dev/null 2>&1 && [[ -f biome.json || -f biome.jsonc ]]; then
            biome format --write "$CHANGED_FILE" 2>/dev/null || true
        elif command -v prettier >/dev/null 2>&1 || [[ -f .prettierrc || -f .prettierrc.json ]]; then
            npx --no-install prettier --write "$CHANGED_FILE" 2>/dev/null || true
        fi
        ;;
    py)
        if command -v ruff >/dev/null 2>&1; then
            ruff format "$CHANGED_FILE" 2>/dev/null || true
            ruff check --fix "$CHANGED_FILE" 2>/dev/null || true
        elif command -v black >/dev/null 2>&1; then
            black --quiet "$CHANGED_FILE" 2>/dev/null || true
        fi
        ;;
    rs)
        command -v rustfmt >/dev/null 2>&1 && rustfmt "$CHANGED_FILE" 2>/dev/null || true
        ;;
    go)
        command -v gofmt >/dev/null 2>&1 && gofmt -w "$CHANGED_FILE" 2>/dev/null || true
        ;;
    json|jsonc)
        if command -v biome >/dev/null 2>&1; then
            biome format --write "$CHANGED_FILE" 2>/dev/null || true
        fi
        ;;
    md|mdx)
        # Markdown formatting is conservative — only if explicitly configured
        if [[ -f .markdownlint.json ]] && command -v markdownlint >/dev/null 2>&1; then
            markdownlint --fix "$CHANGED_FILE" 2>/dev/null || true
        fi
        ;;
    sh|bash)
        command -v shfmt >/dev/null 2>&1 && shfmt -w "$CHANGED_FILE" 2>/dev/null || true
        ;;
esac

exit 0
