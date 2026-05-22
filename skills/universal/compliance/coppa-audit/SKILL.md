---
name: coppa-audit
description: Audit code, data flows, and UI for COPPA (Children's Online Privacy Protection Act) compliance. Use whenever the project handles or might handle data from users under 13 - kid-targeted apps, educational tools, or general apps with under-13 user segments. Triggers on terms like "children", "minor", "under 13", "K-12", "education", "kid", "youth".
---

# COPPA Audit

> Compliance check for code that handles children's data.

**Tradeoff:** Adds a review step before any deploy touching child users. Worth
it: COPPA penalties are up to $51,744 per violation per child (2024 update).

---

## Scope

COPPA applies when ANY of these is true:
- The site/service is directed to children under 13
- The operator has actual knowledge that users under 13 are providing personal
  information
- "Personal information" is interpreted broadly: name, email, geo, photo,
  voice, persistent identifier, screen name, device ID, IP address, …

---

## Checklist

For each release touching children's data:

### Data collection
- [ ] Verifiable parental consent obtained before collecting any PI
- [ ] Consent method documented (credit card verification, knowledge-based
      authentication, video selfie + ID, etc.)
- [ ] No collection beyond what's necessary for the activity
- [ ] No behavioral advertising to under-13 users
- [ ] No tracking pixels from networks that target ads

### Privacy notice
- [ ] Privacy notice clearly posted, accessible from every page
- [ ] Notice lists every data class collected
- [ ] Notice lists every third party with access
- [ ] Notice describes parents' rights (review, delete, refuse further collection)
- [ ] Notice in plain language a parent can understand

### Storage and transmission
- [ ] All PI encrypted in transit (TLS 1.2+, no SSL, no TLS 1.0/1.1)
- [ ] PI encrypted at rest (AES-256 minimum)
- [ ] No PI in logs (verify via `observability-instrument` PII redaction)
- [ ] No PI in error messages returned to the client
- [ ] No PI in URLs (use POST for sensitive ops, never GET)

### Third parties
- [ ] Every third-party service handling PI under contract that obligates
      COPPA compliance
- [ ] Sub-processor list maintained in `docs/compliance/sub-processors.md`
- [ ] No PI sent to analytics platforms that target ads (no GA4 if children
      are in the user base; use Plausible or self-hosted alternatives)

### Deletion and rights
- [ ] Parent-initiated deletion request → all PI for that child purged within
      30 days from primary and backup storage
- [ ] Account deletion is a destructive operation logged for audit
- [ ] Right to refuse further collection is honored

### Technical controls
- [ ] No persistent identifier set on under-13 sessions beyond what's necessary
- [ ] No fingerprinting
- [ ] If using AI features, ALL inputs and outputs containing PI are redacted
      before training/eval datasets (this is now a separate FTC concern)
- [ ] OWASP ASI controls for any agent that processes children's data

---

## Audit artifacts

For each release, produce a COPPA audit report at
`docs/compliance/coppa-audit-<release>.md`:

```markdown
# COPPA Audit — Release vX.Y.Z

**Date**: YYYY-MM-DD
**Auditor**: <user>

## Scope
<which features were reviewed>

## Findings
| Severity | Finding | Status | Remediation |
|----------|---------|--------|-------------|
| critical | ... | open | ... |
| ... | ... | ... | ... |

## Sub-processor list (current)
- ... (with COPPA addendum signed)

## Sign-off
- Audit complete: <user> on <date>
- Engineering ack: <user>
- Legal ack: <user> (or "deferred to release - hold")
```

---

## Where to look for findings

1. `grep -r "console\.log.*user\." src/` — leaked PII in logs
2. Privacy notice file diff — has it been updated for new data classes?
3. CI logs from observability — any span attributes containing emails, names,
   geo? PII redactor should catch these.
4. Network tab in dev tools (manual) — what third-party requests fire on
   under-13 routes?
5. Database schema — is there a `users_under_13` flag? Is it used to gate
   tracking?

---

**This skill is working when:** COPPA audits pass on every release with zero
critical findings.

## References

- 16 CFR Part 312 (COPPA Rule)
- FTC COPPA FAQ (current)
- ICO Age Appropriate Design Code (UK, broader scope but useful checklist)
