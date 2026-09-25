---
name: gitleaks-scan
description: Run gitleaks against the working tree to detect committed secrets, API keys, tokens, and credentials. Use whenever a file has been written, before any git commit, before any push, and as part of the tiered security gate. Catches the most common cause of credential leaks - accidental commits.
---

# Gitleaks Scan

> Catches secrets before they hit the remote, wherever it is wired in: a CI
> step, the pre-commit hook `init-project.sh` installs, or the post-tool hook
> script once a harness registers it (nothing registers it by default).

**Tradeoff:** ~2-5s scan time on file change. Worth it: a leaked secret is a
P0 incident and takes hours to rotate + audit.

---

## When to invoke

- After writing a file that may hold a credential: run
  `gitleaks detect --no-git --source <file> --no-banner` yourself.
  `hooks/universal/post-tool/gitleaks-scan.sh` runs that command, but only
  once the harness registers it as a post-tool hook with a wrapper that
  passes the written file's path as its first argument (for Claude Code, in
  `.claude/settings.json`); `analyzer/install.ts` copies hooks without
  registering them.
- Pre-commit: in `.git/hooks/pre-commit` (installed by `init-project.sh`)
- Pre-push: in `.git/hooks/pre-push`
- CI: on every PR

---

## Install

```bash
brew install gitleaks
# or
go install github.com/gitleaks/gitleaks/v8@latest
```

The post-tool hook `gitleaks-scan.sh` emits a "missing" warning once per
session and skips gracefully if gitleaks isn't installed.

---

## Configure

Project-level: `.gitleaks.toml`. Inherit defaults and add custom rules:

```toml
[extend]
useDefault = true

[[rules]]
id = "internal-client-id"
description = "Internal client ID format"
regex = '''CL-[A-Z0-9]{16}'''
tags = ["client-id", "PII"]
```

Allowlist false positives:

```toml
[allowlist]
description = "Test fixtures"
paths = [
    '''fixtures/test-keys/.*''',
]
```

---

## Tiered usage

See `docs/SECURITY.md` for the full tiered pentest stack. Gitleaks fits at:

- **Tier 1 (every file write)**: post-tool hook, once the harness registers
  it; until then secrets are caught at commit (pre-commit hook, where
  installed) or at PR (the CI step)
- **Tier 2 (every PR)**: CI step blocking merge on findings
- **Tier 3 (pre-release)**: full history scan with `gitleaks detect`

---

## On finding

The post-tool hook, once registered, exits 2; the pre-commit hook, where
installed, blocks the commit; the CI step blocks the PR. The user must:
1. Remove the secret from the file
2. Rotate it if it was real
3. Add to a vault (Doppler, 1Password, Vault, Infisical)
4. Reference via env var

If a secret has ALREADY been committed (caught by Tier 2/3):
1. Rotate immediately
2. Use `git filter-repo` or BFG to scrub history
3. Force-push with team coordination
4. Open a postmortem in `docs/postmortems/`

---

**This skill is working when:** zero secrets reach the remote. Track in
`governance/telemetry/secret-findings.jsonl`.
