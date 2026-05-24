# Skill Signing — Sigstore / Cosign Trust Model

> Authored for Phase 2 area E (spec `specs/phase-2/E-sigstore-signing.md`
> REQ-E4 / AC-E4.1). Documents how DevOPs skills are cryptographically
> signed, how to verify a signature manually, and how the supply chain
> hangs together. The companion install-side documentation -- how the
> analyzer/install.ts verifier consumes these signatures -- is authored
> in area F (spec `specs/phase-2/F-skill-provenance.md`) and ships in
> Phase 2 sessions 7-8.

---

## Why Sigstore

DevOPs ships skills via the canonical `skills/universal/**/SKILL.md` path
and (in Phase 2 area D) `skills/stack-specific/**/SKILL.md`. Each is a
text artifact downstream agents consume as instruction. The supply-chain
threat: an attacker who can modify a skill file ships malicious
behaviour to every downstream agent that picks it up. **OWASP AST02**
(Skill poisoning at registry) and **AST08** (Skill update tampering)
name this threat class directly (see `governance/owasp-asi-2026/threats.md`).

The defense is cryptographic provenance: every skill carries a
verifiable signature; downstream consumers refuse skills whose signature
fails verification.

**Sigstore over GPG-style key infrastructure** for three reasons:

1. **No long-lived key custody.** Sigstore's keyless flow issues a
   short-lived signing certificate via OIDC at signing time. No
   `~/.gnupg/secring.gpg` to back up, lose, or have stolen.
2. **Public auditability via Rekor.** Every signature event lands in
   the Rekor transparency log (`https://rekor.sigstore.dev`), publicly
   verifiable. A reviewer can confirm a signature was actually produced
   by the claimed identity at the claimed time.
3. **GitHub Actions native.** The CI workflow's OIDC token IS the
   signing identity. No secret credential to inject; the runner's
   provenance IS the signing provenance.

The Phase 2 implementation specifically uses **cosign v2.x** (Sigstore's
canonical CLI). The cosign version is pinned in
`.github/workflows/release-sign.yml` (REQ-E6 / E.06 sec-review) and
recorded per-entry in `governance/skill-manifest.yml` under
`signed_with_version` so reproducibility is auditable.

---

## Signing identity

The signing identity is the **GitHub Actions workflow's OIDC identity**
on the `phase-2-security-depth` branch (later: `main`) of
`MILTONADINA/DevOPs`. The identity is bound to:

- Repository: `https://github.com/MILTONADINA/DevOPs`
- Ref: the workflow's `github.ref` at signing time (e.g.,
  `refs/tags/v0.2.0` for a release-tag signing, or
  `refs/heads/phase-2-security-depth` for workflow_dispatch testing)
- Workflow file: `.github/workflows/release-sign.yml`
- Job: `sign`

Together those bindings appear in the OIDC token's `subject` claim,
which Sigstore's Fulcio embeds in the issued signing certificate. A
verifier consuming a signature can check those claims against
operator-controlled allowlists -- this is the load-bearing identity
discipline.

**Why no human signer.** A human-tied signing identity (e.g.,
`miltonadina@gmail.com` via GitHub OAuth) would create a single point
of compromise: if the human's GitHub account is hijacked, signing
shifts. The workflow identity is bound to the repository and ref, not
the human; an attacker would need to compromise the GitHub-Actions
infrastructure itself to forge a valid signature with the recorded
identity.

---

## Verify manually

To verify a SKILL.md against its signature locally:

```bash
# Install cosign if not present (one-time, per the version pin in
# .github/workflows/release-sign.yml; check current pin before
# installing).
curl -sSfL https://github.com/sigstore/cosign/releases/download/v2.4.0/cosign-linux-amd64 \
  -o ~/bin/cosign && chmod +x ~/bin/cosign

# Verify a specific skill. The .sig file lives alongside the SKILL.md.
cosign verify-blob \
  --certificate-identity-regexp 'https://github.com/MILTONADINA/DevOPs/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --signature skills/universal/process/karpathy-guidelines/SKILL.md.sig \
  skills/universal/process/karpathy-guidelines/SKILL.md
```

Expected output on a valid signature: `Verified OK`. Expected output on
a tampered skill or wrong signature: a non-zero exit + an error naming
the file.

For offline verification, point `cosign verify-blob` at the cached
trust-bundle:

```bash
cosign verify-blob \
  --bundle-path .workflow/sigstore/trust-bundle.json \
  --signature skills/universal/process/karpathy-guidelines/SKILL.md.sig \
  skills/universal/process/karpathy-guidelines/SKILL.md
```

The trust bundle is the Sigstore root-of-trust at a frozen point in
time -- it's refreshed weekly by
`.github/workflows/refresh-trust-bundle.yml` (E.05) so the offline path
stays current.

The Rekor entry for a signature is queryable by its index (stored in
the manifest's `rekor_log_index` field):

```bash
rekor-cli get --log-index <number>
```

This returns the full Rekor record: the certificate, the signing time,
and the binding to the workflow identity.

---

## What to do on failure

If `cosign verify-blob` exits non-zero against a SKILL.md you expect to
be valid, work through the failure modes in this order:

1. **Outdated trust bundle.** If verifying offline, refresh:
   ```bash
   curl -sSfL https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json \
     -o .workflow/sigstore/trust-bundle.json
   ```
   The weekly workflow normally keeps this current; manual refresh
   handles the edge case.

2. **Tampered skill.** If the SKILL.md was modified post-signing, the
   sha256 in the manifest will mismatch the file's current sha256.
   Compute the current hash and compare:
   ```bash
   sha256sum skills/universal/<area>/<topic>/SKILL.md
   grep -A2 "name: <topic>" governance/skill-manifest.yml | grep sha256
   ```
   If they differ, the skill has been modified without re-signing. **Do
   NOT use the skill** -- re-sign via a new release tag (or
   workflow_dispatch on `release-sign.yml`), then re-verify.

3. **Wrong identity binding.** If the certificate's identity claim
   doesn't match the expected `MILTONADINA/DevOPs` workflow, the
   signature was produced by a different repository. **Treat as
   compromise** -- something is signing on behalf of this project
   without authorization.

4. **Stale Rekor entry.** If `rekor-cli get --log-index <n>` returns
   a record whose certificate has been revoked, the signing identity
   has been rotated. Verify against the current trust bundle (Sigstore's
   trust root is updated when identities are rotated); old signatures
   remain valid against the trust bundle that was current at signing
   time.

When a verification failure happens in production (e.g., a consumer
project's `analyzer/install.ts` refuses to install a skill), the
failure should produce a structured log entry tagged
`skill_verification_failure` for downstream incident response.

---

## Rotation policy

The signing identity is bound to the GitHub Actions workflow's OIDC
configuration. Rotation paths:

### Routine: cosign version upgrade

cosign upgrades happen at the v0.x.x boundary. The discipline:

1. Update the `cosign-installer` action's pinned SHA in
   `.github/workflows/release-sign.yml` (verify via
   `git ls-remote https://github.com/sigstore/cosign-installer refs/tags/<v>`).
2. Update the `signed_with_version` field documentation in the manifest's
   header comment.
3. The next release-sign.yml run signs with the new version; the
   manifest's `signed_with_version` per-entry field captures the actual
   version used per-signing.

This is a routine maintenance task, not a security event. The pinned
version is documented in `B.10-sha-pinning.md` semantics: tag-move
attacks on cosign-installer would otherwise compromise the signing layer.

### Emergency: identity binding change

If the GitHub repository moves (e.g., `MILTONADINA/DevOPs` →
`<org>/DevOPs`), the OIDC subject claim changes. Existing signatures
remain valid against their original identity, but new signatures bind
to the new identity. Discipline:

1. Update `docs/SKILL_SIGNING.md` "Signing identity" section.
2. Update verifier allowlists in `analyzer/install.ts` (area F).
3. Old signatures stay valid (they're cryptographically bound to the
   record); new releases produce new signatures under the new identity.

### Compromise: signing-key event

Sigstore's keyless flow has no long-lived signing key to rotate. A
compromise of the GitHub Actions runner or Fulcio infrastructure is
handled by Sigstore upstream (the trust bundle is refreshed; signatures
issued in the compromise window are queryable in Rekor for forensics).
Project-side response: refresh the local trust bundle, re-verify
critical signatures, escalate if any fail.

---

## Refresh cadence

The Sigstore trust bundle at `.workflow/sigstore/trust-bundle.json` is
refreshed **weekly** by `.github/workflows/refresh-trust-bundle.yml`
(authored under E.05). Weekly is a defensible default — Sigstore's
root-of-trust rotation is historically a low-frequency event, but the
trust bundle should track it. Operators wanting tighter freshness can
override the cadence per project.

---

## See also

- `governance/skill-manifest.yml` — the per-skill manifest with
  sha256 + signature metadata.
- `.github/workflows/release-sign.yml` — the signing workflow (E.03).
- `.github/workflows/refresh-trust-bundle.yml` — weekly trust-bundle
  refresh (E.05).
- `.workflow/sigstore/trust-bundle.json` — cached root-of-trust for
  offline verification.
- `specs/phase-2/F-skill-provenance.md` — install-time verification
  side of the supply chain (Phase 2 sessions 7-8).
- `governance/owasp-asi-2026/threats.md` — AST02 + AST08 threat
  references.
- Sigstore upstream: https://www.sigstore.dev
- cosign: https://github.com/sigstore/cosign
- Rekor: https://docs.sigstore.dev/logging/overview/
