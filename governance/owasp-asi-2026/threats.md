# OWASP Top 10 for Agentic Applications 2026 — Reference

Released by OWASP in December 2025. Used as the agentic-AI security baseline.

## The 10 threats

### ASI01 — Agent Goal Hijacking (#1 risk for 2026)
External input redirects the agent's objective. Defense: prompt-injection-defense skill,
external-content markers, source classification.

### ASI02 — Tool Misuse
Agent invokes a tool in a harmful way. Defense: pre-tool hooks (block-rm-rf,
block-prod-write, etc.), per-subagent tool allowlists.

### ASI03 — Identity and Privilege Abuse
Agent or subagent acts with more privilege than required. Defense: per-subagent
scoped permissions in subagent definitions; least-privilege tokens.

### ASI04 — Indirect Prompt Injection
Hidden instructions in documents, RAG content, tool outputs alter behavior.
Defense: prompt-injection-defense skill, sanitization of all external content.

### ASI05 — Memory Poisoning
Persistent memory corrupted to influence future sessions. Defense: Stratum
git-attestation cross-referencing memory against git history; audit_conflicts.

### ASI06 — Inter-agent Communication Attacks
One agent attacks another. Defense: subagent output validated by parent before
propagating; signed inter-agent messages where applicable.

### ASI07 — Resource Exhaustion
Runaway cost or infinite loops. Defense: hooks/pre-tool/budget-brake.sh,
loop-detection.sh, scratchpad-stasis detection.

### ASI08 — Recursive Hijacking
Goal modifications propagate through reasoning chains. Defense: constitution
layer reloaded every turn; immutable per session.

### ASI09 — Human-Agent Trust Exploitation
Agent socially-engineered into bypassing constraints. Defense: hard hooks fire
regardless of agent intent.

### ASI10 — Rogue Agents
Compromised agent operates undetected. Defense: all actions logged to
events.jsonl; daily cost ledger reconciliation.

## Related — OWASP Agentic Skills Top 10 (AST10)

Specifically for skill supply chain (released Q1 2026):

- AST01: Untrusted skill registries
- AST02: Skill poisoning at registry level (e.g., ClawHub incident)
- AST03: Skill name typosquatting
- AST04: Skill metadata manipulation
- AST05: Skill privilege escalation
- AST06: Skill-to-skill side channels
- AST07: Dependency injection via skill manifests
- AST08: Skill update tampering
- AST09: Skill telemetry exfiltration
- AST10: Skill collusion (multiple skills cooperating maliciously)

Defense: skills signed with Sigstore/Cosign, hash-pinned in
`.workflow/devops-version.yml`, only signed skills installed by default.

## Red-team toolkit

- DeepTeam with `OWASP_ASI_2026()` framework
- PyRIT (Microsoft)
- Garak

Run as a CI gate before any release that changes agent behavior.
