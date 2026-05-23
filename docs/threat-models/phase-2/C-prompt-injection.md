# Threat Model — Phase 2 Area C — Prompt Injection Defense Hardening

**Spec**: `specs/phase-2/C-prompt-injection-hardening.md`
**Date**: 2026-05-22
**Author**: miltonadina (Claude Code, Opus 4.7)
**Reviewer**: miltonadina
**Status**: draft

---

## System sketch

```
external sources
   ├─ RAG document chunk
   ├─ MCP tool output (incl. Lyrie's CVE corpus from area A)
   ├─ web fetch result
   ├─ user upload
   └─ git-stash / pasted snippet
       │
       ▼  [TRUST BOUNDARY — external source ↔ boundary layer]
       boundary layer (observability/external-content-boundary.ts)
       │   ├─ rebuff in-process classifier
       │   ├─ lakera-guard HTTP call (optional, env-gated)
       │   └─ HMAC-SHA256(session_key, content || source || "untrusted=true")
       │
       ▼ produces:  <external-content untrusted="true" source="<o>" hmac="<sig>">…
       │
       │  [TRUST BOUNDARY — boundary layer ↔ agent context]
       │  ◄  TEMPLATE CALLS THIS OUT AS "OFTEN MISSED"
       │
       agent runtime (constitution loaded every turn; markers treated as data)
       │
       ▼ proposed tool call (write, push, deploy, exec, db-mutate, …)
       │
       │  [TRUST BOUNDARY — agent ↔ tool]
       │
       pre-tool hook: external-content-boundary.sh
          ├─ re-compute HMAC over wrapper body
          ├─ compare against marker's hmac attribute
          ├─ check rebuff/lakera score against block threshold
          └─ if blocked, require unconsumed approval_token from approvals.jsonl
       │
       ▼  PROCEED (hmac_verified=true, approval matched)
       │  OR
       ▼  HALT + write blocker + log to events.jsonl
       tool invocation
```

The cryptographic gate is the source of truth: only content the boundary layer wrapped carries a valid HMAC; anything else is rejected at tool-invocation time regardless of agent intent.

## Trust boundaries

1. **External source → boundary layer** [TRUST BOUNDARY] — every external payload passes through the boundary before entering context. Rebuff (and lakera-guard, when active) score the payload; HMAC-signed wrapper is the artifact that enters context.
2. **Boundary layer → agent context (the "agent ↔ external content" boundary)** [TRUST BOUNDARY — TEMPLATE-FLAGGED AS "OFTEN MISSED"] — the agent must treat wrapped content as data, not instructions. This is the constitutionally most-important boundary in this spec: the agent cannot reason itself across it because the cryptographic gate fires at tool-invocation time external to its decision loop. This is the boundary that ASI01 (Goal Hijacking) attacks most often cross undetected without an explicit mitigation; this spec makes the boundary cryptographic rather than discretionary.
3. **Agent → tool** [TRUST BOUNDARY] — pre-tool hook re-verifies HMAC + injection-threshold + approval-token before invoking destructive tools.
4. **User → `devops approve` CLI** [TRUST BOUNDARY] — the only recognised human-override path; manual edits to `approvals.jsonl` are explicitly NOT a recognised approval mechanism per REQ-C6 Decisions.
5. **Session-key store → boundary layer + pre-tool hook** [TRUST BOUNDARY] — `.workflow/state/session-key` (0600 perms, gitignored, per-session rotation); both signing and verification read the same local secret.

## Data classes

| Class | Where stored | Where transmitted | Retention |
|-------|--------------|-------------------|-----------|
| External-content payload | wrapped in agent context only | OTel span (PII-redacted) | session-scoped |
| Session HMAC key | `.workflow/state/session-key` (0600) | local-only (never transmitted) | per session |
| `approval_token` (16-byte random) | `approvals.jsonl` | local-only | session; consumed on first use (AC-C6.3) |
| Rationale strings | `approvals.jsonl` | telemetry export (PII-redacted) | session |
| Detection scores (rebuff/lakera) | OTel baggage | telemetry backends (PII-redacted) | per provider retention |

---

## STRIDE analysis

| Threat | Description | Mitigation | Status |
|--------|-------------|------------|--------|
| **Spoofing** | Malicious payload spoofs the wrapper format (fakes `<external-content … hmac="…">` without actually passing through the boundary) | Pre-tool hook re-computes HMAC over the wrapper body using the local `session_key`; mismatch → halt (REQ-C5). Only the boundary layer (REQ-C1, REQ-C3) has the key in scope to produce valid HMACs | spec'd |
| **Tampering** | Wrapped payload modified after wrapping but before tool-call | HMAC re-computation catches modification — if any byte of `content || source || "untrusted=true"` changes, the recomputed HMAC differs and the hook halts | spec'd |
| **Repudiation** | Who approved a destructive call after an injection alert? | `devops approve` writes a timestamped, identity-attributed entry to `approvals.jsonl` (REQ-C6); telemetry emits per-invocation event | spec'd |
| **Information disclosure** | Detector logs contain payload PII | PII-redaction at OTel exporter (NFR-C4); rationale strings logged verbatim but PII-redacted before any telemetry export | spec'd |
| **Denial of service** | Flood the boundary layer with payloads to slow the agent | In-process `rebuff` is cheap (NFR-C1 ≤ 50 ms p95); `lakera-guard` HTTP call has 2-sec budget; per-payload latency bounded | spec'd |
| **Elevation of privilege** | Forge an `approval_token` to bypass an injection block | `approval_token` is 16-byte cryptographic random per `devops approve` invocation; one-shot consumption (AC-C6.3); manual edits to `approvals.jsonl` NOT a recognised path (REQ-C6 Decisions) | spec'd |

---

## OWASP Top 10 for Agentic Applications (ASI) 2026

| ID | Threat | Applicable? | Description | Mitigation | Status |
|----|--------|------------|-------------|------------|--------|
| ASI01 | Agent Goal Hijacking | **YES — DIRECT TARGET** (#1 risk for 2026) | This spec exists to address ASI01 | rebuff detection + HMAC wrapper (REQ-C3) + threshold-based blocking of destructive tool calls (REQ-C5, REQ-C6) | spec'd |
| ASI02 | Tool Misuse | YES (indirect) | An injection that elicits a destructive tool call | REQ-C6 blocks destructive tool calls when detection confidence ≥ block threshold until `devops approve` is run | spec'd |
| ASI03 | Identity and Privilege Abuse | N/A | Injection does not directly escalate privilege within this spec's scope | — | N/A |
| ASI04 | Indirect Prompt Injection | **YES — DIRECT TARGET** | Hidden instructions in RAG / MCP / web / user-upload content | Same as ASI01 — all external content wrapped + scored before entering context | spec'd |
| ASI05 | Memory Poisoning | N/A (Phase 3) | Memory-layer concern; deferred to Phase 3 `memory/stratum/` | — | N/A |
| ASI06 | Inter-agent Communication Attacks | N/A | Single-agent in this spec's scope | — | N/A |
| ASI07 | Resource Exhaustion | YES | A malicious source could flood the boundary with payloads | rebuff is in-process and cheap; per-payload latency bounded (NFR-C1); upstream rate-limiting is the calling project's responsibility | spec'd + delegated |
| ASI08 | Recursive Hijacking | YES | Injection propagating through reasoning chains | Constitution-load-every-turn (Phase 1) + HMAC wrapper discipline (this spec) means each turn re-establishes the boundary independent of prior context | implemented + spec'd |
| ASI09 | Human-Agent Trust Exploitation | YES | The agent could be socially-engineered (via injected content) into bypassing constraints | Hooks fire regardless of agent intent — the agent cannot reason itself past the pre-tool hook because the gate is external to its decision loop | implemented (hook discipline) + spec'd |
| ASI10 | Rogue Agents | N/A | Single-agent scope | — | N/A |

---

## Open issues

> Block merge until resolved.

1. **Session-key lifecycle rotation enforcement** — REQ-C3 specifies per-session rotation and 0600 file mode, but the rotation cadence at session-end must be explicitly enforced. Confirm during Step 3 plan atomization that a `hooks/universal/session-end/rotate-session-key.sh` post-session hook is named, and that session-start regenerates the key before the boundary layer initialises. **Not blocking** Step 3 itself; flagged here so the lifecycle isn't left implicit.

---

## Sign-off

- [ ] Engineer: miltonadina — pending
- [ ] Security reviewer: miltonadina — pending
- [ ] Red-team scan (`deepteam OWASP_ASI_2026()`): pending — spec C is a primary subject of ASI01/ASI04 probes; the scan from spec B's gate IS the empirical test for this threat model
