# Roadmap

## Phase 1 — Foundation (current)

- Constitution (Karpathy + DevOPs extensions)
- Universal hooks (deterministic safety floor)
- 17 universal skills
- Analyzer (stack/domain/state/risk detection + recommendations)
- Claim validator (proof-of-work enforcement)
- Plugin packaging
- Three memory backends wired
- Mode + lifecycle scaffolding
- 7 templates (EARS, ADR, threat model, runbook, postmortem, SLO, status)
- Cost controls (budget, model routing, loop thresholds)
- Observability (OTel + Langfuse + Laminar + PII redaction)

## Phase 2 — Security depth (next)

- Full pentest stack integration: Shannon, PentAGI, Lyrie, pentest-ai-MCP
- OWASP ASI 2026 DeepTeam red-team in CI
- Prompt injection defense hardening with rebuff/lakera-guard
- Stack-specific security skills (Next.js, Supabase, Stripe, FastAPI, Axum)
- Sigstore/Cosign skill signing
- Skill provenance verification at install

## Phase 3 — Memory & observability depth (Stratum closeout — Option B)

- **Stratum closeout — Option B locked 2026-05-24** (was: "Stratum Phase 2
  pruning integration — CQ-Extended KadaneDial"). Stratum upstream is a
  single-commit scaffold per audit
  `.workflow/state/stratum-audit/01-stratum-state.md`; the prior line
  presupposed a working backend that does not exist. Phase 3 therefore
  absorbs Stratum's own **Phase 0** (session capture + waste taxonomy) +
  **Phase 1** (measurement proxy + exact token counting + dashboard) +
  **Phase 3** (three-tier memory + Llama fact extractor + Pinecone +
  Neo4j) — plus integration with DevOPs as memory backend. Estimated
  effort **~619h total** (Stratum-side build 240–480h + DevOPs Phase 3
  base ~60h + integration 10–20h + ops deployment 13–25h, per
  `.workflow/state/stratum-audit/03-integration.md`). Stratum **Phase 2**
  (KadaneDial pruner) and **Phase 5** (git-attestation audit) are
  **explicitly deferred to post-v0.3.0** — re-scope possible after
  Phase 0+1+3 ships and real telemetry surfaces.
- Cross-project meta-memory with PII scrubbing
- Eval datasets in Langfuse with regression tracking
- Production replay via Laminar
- Per-tenant cost attribution dashboards
- Anomaly detection on cost ledger

## Phase 4 — Design phase skills

- Automated threat modeling from system sketches
- C4 diagram generation skill
- ERD generation from data classes
- ADR template completion via researcher subagent
- Performance budgets per feature
- Accessibility budgets (WCAG 2.2 AA enforcement)

## Phase 5 — SRE & operate

- SLO templates filled by lifecycle/launch phase
- Runbook auto-generation from incident patterns
- Postmortem skill with timeline reconstruction
- Cost attribution dashboards (Grafana templates)
- On-call rotation integration

## Phase 6 — Self-improvement loop

- Telemetry-driven recommendation tuning
- Skill self-evaluation and replacement
- Cross-project pattern extraction (PII-scrubbed)
- Personal preference learning per user
- A/B testing of prompt/skill variants
