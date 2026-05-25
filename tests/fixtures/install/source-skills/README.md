# Install-time Provenance Fixtures (F.09)

Phase 2 Area F / REQ-F1 through REQ-F7 — three deterministic fixture
skills exercising the installer's verification paths.

## Three fixture skills

| Directory | State | ACs exercised |
|---|---|---|
| `signed/` | Real signed skill — uses `skills/universal/process/karpathy-guidelines/SKILL.md` + its `.sig` + `.bundle` from session 6's E.04 signing run. | AC-F1.1 (verify path: cosign returns 0) |
| `unsigned-missing-sig/` | SKILL.md present, NO `.sig` file. | AC-F2.1 (reject-unsigned, exit 2) + AC-F3.1 (override with `--allow-unsigned --rationale=...`) |
| `unsigned-mismatched-sig/` | SKILL.md present, structurally valid `.sig` that signs DIFFERENT content. | AC-F2.1 (reject on hash/sig mismatch) |

## Why each shape matters

- **signed/** — the happy path. The bundle is the real Sigstore artefact
  produced by `release-sign.yml` in session 6 (CI run 26350280371). It
  validates against the live Sigstore trust root.
- **unsigned-missing-sig/** — the most common operator scenario: a
  hand-authored skill landing before a signing run has been triggered.
  Default behaviour: reject. With `--allow-unsigned --rationale="..."`:
  proceed + log to `install.log`.
- **unsigned-mismatched-sig/** — adversarial scenario: an attacker writes
  a malicious skill but copies a `.sig` from a legitimate one. The hash
  check (NFR-F3 defense-in-depth) catches this independently of cosign;
  even with `--allow-unsigned`, the **hash mismatch** still rejects.

## How to exercise

```bash
# Default reject-unsigned (exit 2)
node analyzer/install.ts --target /tmp/fixture-proj \
  --manifest tests/manifests/dev.yml
# → "unsigned: skills/universal/.../SKILL.md"
# → exit code 2

# Override with rationale (allowed because hash matches)
node analyzer/install.ts --target /tmp/fixture-proj \
  --manifest tests/manifests/dev.yml \
  --allow-unsigned --rationale="Test fixture; not for production"
# → "verified" in install.log, decision=overridden

# Reject missing-rationale
node analyzer/install.ts --target /tmp/fixture-proj \
  --manifest tests/manifests/dev.yml \
  --allow-unsigned
# → exit 1, "--rationale=\"...\" is required when --allow-unsigned is used"

# Dry-run (no target mutation)
node analyzer/install.ts --target /tmp/fixture-proj \
  --manifest tests/manifests/dev.yml \
  --allow-unsigned --rationale="dry-run smoke test" \
  --dry-run
# → "dry-run: would copy N skills"; target untouched
```

## Cross-area dependency

This fixture's `signed/SKILL.md` artefact comes from session 6's E.04
first signing run. Without that run, no real signed skill exists for
AC-F1.1 verification. The cross-area dep is documented in plan F as
**F.09 ← E.04**. Cleared 2026-05-24 session 6.
