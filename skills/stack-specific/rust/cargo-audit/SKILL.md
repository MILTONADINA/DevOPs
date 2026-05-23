---
name: rust-cargo-audit
description: Cargo dependency auditing discipline -- `cargo audit` invocation in CI, `cargo-deny` advisory enforcement, RUSTSEC ID monitoring, and pinned-version vs floating-range tradeoffs. Triggers on Rust dependency authoring (`Cargo.toml` edits, `Cargo.lock` updates). OWASP AST08 (Update tampering) defense -- pinned versions plus CI advisory enforcement close the supply-chain side of the dependency-bump attack surface.
---

# Rust Cargo Audit

> Defends against **OWASP AST08 (Update tampering)** for the Rust
> dependency surface. `cargo audit` consults the
> [RustSec Advisory Database](https://rustsec.org) for known
> vulnerabilities in your `Cargo.lock`; `cargo-deny` extends to license,
> source, and ban-list enforcement. Together they close the
> dependency-side of the supply-chain attack surface: a malicious
> dependency-bump PR (typosquatting on a popular crate, a compromised
> maintainer pushing a backdoored release) gets flagged before merge.

**Tradeoff:** CI gates on dependency advisories slow some PRs
(legitimate updates to advisory-flagged crates need a manual
ack-and-merge). Worth it: the alternative is silent acceptance of a
known-vulnerable dependency, which becomes an open vulnerability
ticket the moment a researcher publishes details.

---

## Why this matters

Cargo's default behavior:

- Dependencies declared in `Cargo.toml` use semver ranges (`^1.2.0`
  resolves to any 1.x). The `Cargo.lock` pins exact versions, but
  `cargo update` re-resolves within the semver range.
- Crates are pulled from `crates.io` by default. The registry has no
  hard-blocked-list on known-malicious crates; advisory enforcement
  is a separate layer.
- A maintainer-account compromise on a transitive dependency can push
  a malicious version that satisfies your semver range. `cargo build`
  pulls it; tests pass (the malicious code activates only in
  production environments); the supply-chain attack ships.

The defense is to consult the RustSec Advisory Database at every
dependency update, with CI enforcement that blocks merges on
advisory matches.

---

## Pattern 1 -- `cargo audit` in CI on every PR

```yaml
# .github/workflows/security-audit.yml
name: Security Audit

on:
  pull_request:
    paths:
      - 'Cargo.toml'
      - 'Cargo.lock'
      - '.github/workflows/security-audit.yml'
  push:
    branches: [main]
  schedule:
    - cron: '0 9 * * 1'  # weekly Monday 09:00 UTC, catches new advisories on existing deps

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rustsec/audit-check@v2.0.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          # Or pin to a specific commit SHA for AST08 defense on the
          # auditor action itself.
```

The `audit-check` action reads `Cargo.lock`, consults the RustSec
database, and fails the workflow on any matching advisory. The
weekly cron catches advisories published AFTER a dependency was
last touched -- a crate you depend on may be safe today and flagged
tomorrow.

For direct `cargo audit` invocation without the action:

```bash
cargo install cargo-audit --locked
cargo audit --deny warnings
```

`--deny warnings` upgrades warning-level findings to errors;
appropriate for CI gates where the policy is "block on any finding".

---

## Pattern 2 -- `cargo-deny` for license + source + ban-list enforcement

`cargo-deny` extends `cargo audit` with three additional dimensions:

```toml
# deny.toml
[advisories]
db-path = "~/.cargo/advisory-db"
db-urls = ["https://github.com/RustSec/advisory-db"]
vulnerability = "deny"
unmaintained = "warn"
unsound = "warn"
yanked = "deny"
notice = "warn"

[licenses]
unlicensed = "deny"
allow = ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"]
deny = ["GPL-3.0", "AGPL-3.0"]  # if your project's license is incompatible

[bans]
multiple-versions = "warn"
deny = [
  { name = "openssl", version = "*" },  # if you've standardised on rustls
]

[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
```

Run via `cargo deny check`. Wire into the same CI workflow as
`cargo audit`; the two checks are complementary rather than
redundant.

---

## Pattern 3 -- Pinned versions for security-critical dependencies

For crates whose security properties you depend on heavily
(cryptography, auth, TLS, database drivers), pin to an exact version
rather than a semver range:

```toml
# Cargo.toml
[dependencies]
# Routine deps: semver range
serde = "1"
tokio = "1.40"

# Security-critical: exact version pin
ring = "=0.17.8"
rustls = "=0.23.13"
sqlx = { version = "=0.8.2", features = ["postgres", "runtime-tokio-rustls"] }
```

The `=` prefix forces exact match. `cargo update` cannot move these
to a new version without an explicit `Cargo.toml` edit, which is a
visible PR diff a security reviewer can scrutinize.

Tradeoff: missed security PATCHES on pinned crates require manual
bumps. Mitigate with `cargo audit`'s weekly cron (Pattern 1) -- a
new advisory on a pinned crate fires a workflow failure that
prompts an explicit version-bump PR with review.

---

## Anti-patterns

### Anti-pattern 1 -- No `cargo audit` in CI

```yaml
# WRONG: CI runs tests but never audits dependencies
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - run: cargo test
      # No cargo audit step. Known-vulnerable dependencies merge silently.
```

Every PR that bumps a dependency (intentionally or transitively) is a
potential supply-chain incident waiting to be discovered. Without
`cargo audit` in CI, the discovery happens in production. Add the
audit step to every PR workflow.

### Anti-pattern 2 -- Floating ranges on security-critical deps

```toml
# WRONG
[dependencies]
ring = "*"               # any version, including known-bad ones
openssl = ">=0.10.0"     # accepts ANY 0.10.x or higher, including new majors
jsonwebtoken = "8"       # accepts any 8.x.x, including a compromised 8.99.0
```

Wildcards and unbounded ranges defeat the entire purpose of `Cargo.lock`
pinning. A `cargo update` (which dependabot, renovate, or a manual
bump might trigger) silently moves to whatever resolves -- including
a maintainer-compromised release. Use `=` for security-critical pins
and tight semver ranges (`^1.2.3` rather than `*`) for everything else.

### Anti-pattern 3 -- Auto-merging dependency PRs without audit review

```yaml
# WRONG: GitHub auto-merge enabled for any green dependency PR
- uses: pascalgn/automerge-action@v0.16.4
  with:
    merge_method: squash
    update_label: "automerge"
```

Even with `cargo audit` in CI, a green build means "no KNOWN advisory
at this point in time". A compromised dependency that has not yet been
reported to RustSec passes audit. Auto-merging dependency PRs without
human review means the only defense is RustSec's reporting latency.

Disable auto-merge on dependency-bump PRs. A two-minute glance from
a reviewer at the diff catches obvious red flags (a popular crate's
maintainer changed, the patch version bumps by 50, a 1MB code change
in a 10KB crate) that automated tooling won't.

---

## ASI/AST mapping

This skill addresses **canonical OWASP AST08 (Update tampering)** from
`governance/owasp-asi-2026/threats.md` (the AST10 section). The
attack pattern: an attacker compromises a Rust crate maintainer's
account (or typosquats a popular crate name) and pushes a malicious
version. The defense is structural:

1. Pin security-critical versions exactly (Pattern 3) so updates are
   visible diffs.
2. Audit on every PR + weekly (Pattern 1) so known advisories block
   merge.
3. Enforce license / source / ban policies (Pattern 2) so a typosquat
   from an unknown registry trips the check.

`cargo audit` + `cargo-deny` together cover the dependency surface
that AST08 names. The complementary
[`stack-specific/rust/error-handling`](../error-handling/SKILL.md)
skill addresses the runtime-side hygiene that lets the supply-chain
defenses operate in a non-crashing process.

---

## Testing

Verification an audit-gated Rust project should pass:

- `cargo audit` exits 0 on the current `Cargo.lock` (no open advisories).
- A test-fixture PR that adds `serde_yaml = "0.8.0"` (a yanked
  crate with a known advisory) fails CI as expected -- proves the
  gate works.
- `cargo deny check` exits 0 with the project's `deny.toml`.
- The CI workflow file pins the `rustsec/audit-check` action to a
  commit SHA, not a branch / tag (AST08 defense on the auditor itself).

---

## See also

- `governance/owasp-asi-2026/threats.md` -- AST08 (Update tampering)
- RustSec Advisory Database: https://rustsec.org
- `cargo-audit`: https://docs.rs/cargo-audit/
- `cargo-deny`: https://embarkstudios.github.io/cargo-deny/
- `skills/stack-specific/rust/error-handling/SKILL.md` -- the
  runtime-hygiene companion skill
