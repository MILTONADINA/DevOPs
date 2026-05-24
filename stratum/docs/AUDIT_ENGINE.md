# AUDIT_ENGINE.md — Git-Attestation and Escalating Audit

## Purpose

The Audit Engine prevents CQ's memory system from becoming a hallucination amplifier. If we store a false fact and later inject it as context, we have made the AI worse, not better.

The engine operates on a three-tier escalation model:

```
Tier 1: Git-Attestation   → $0 cost, deterministic
Tier 2: Llama spot-check  → ~$0.001, probabilistic
Tier 3: Opus escalation   → ~$0.01, high-accuracy (rare)
```

The goal: catch conflicts before they reach the LLM, at the lowest possible cost.

---

## Tier 1 — Git-Attestation (Deterministic)

### What It Does

For every structured fact that is code-related (type: `FunctionChange`, `VariableChange`, or `TechDecision` with domain `"infrastructure"` or `"database"`), Git-Attestation cross-references the fact against the project's actual commit history.

### How It Works

```typescript
// src/audit/git-attestation.ts

interface AttestationResult {
  status: "CONFIRMED" | "UNVERIFIED" | "CONFLICT";
  evidence?: {
    commit_hash: string;
    commit_message: string;
    timestamp: number;
    file_diff_summary?: string;
  };
  conflict_detail?: string;
}

async function attestFact(fact: AnyFact, repo_id: string): Promise<AttestationResult>
```

**CONFIRMED:** The Neo4j graph contains a commit that validates the fact. Example: `FunctionChange { old_name: "getUser", new_name: "fetchUser" }` → graph confirms a commit at the stated timestamp modifying that function.

**UNVERIFIED:** No matching commit found in the graph. The fact may be correct but unindexed, or may be a hallucination. Escalate to Tier 2.

**CONFLICT:** The graph contains evidence that contradicts the fact. Example: the fact claims `fetchUser` was introduced in commit `a3f9b2`, but the graph shows `fetchUser` was deleted in commit `c7d1e4` six weeks later. Suppress the fact.

### Neo4j Queries

```cypher
-- Confirm a FunctionChange fact
MATCH (old:Function {name: $old_name})
OPTIONAL MATCH (old)-[:DEPRECATED_BY {at: $claimed_timestamp}]->(new:Function {name: $new_name})
RETURN old.status, new.name, new.status

-- Check for post-fact contradictions
MATCH (f:Function {name: $new_name})-[:REFERENCED_IN]->(c:Commit)
WHERE c.timestamp > $claimed_timestamp
RETURN c.hash, c.message, c.timestamp
ORDER BY c.timestamp ASC
LIMIT 5
```

### Git Index Pipeline

The Git index runs as a background job, not on the critical path. It is triggered:
- When a new repository is connected to CQ (full index)
- Every hour (incremental, last 100 commits)
- On webhook (GitHub/GitLab push events, real-time)

```typescript
// src/audit/git-indexer.ts

async function indexRepository(repo_url: string, since?: Date) {
  const commits = await fetchCommits(repo_url, since);
  for (const commit of commits) {
    const diff = await fetchDiff(commit.hash);
    const changes = parseDiff(diff);
    await writeToNeo4j(commit, changes);
  }
}

function parseDiff(diff: string): FunctionChange[] {
  // Parse unified diff format
  // Detect: function additions, removals, renames
  // Detect: variable changes in config files
  // Output: structured list of code changes
}
```

---

## Tier 2 — Llama Spot-Check (Probabilistic)

Triggered when Git-Attestation returns `UNVERIFIED` — i.e., the fact has no commit evidence but also no contradiction.

### What It Does

Sends the fact plus a few surrounding context turns to Llama 4-8B and asks for a logical coherence check:

```
System: You are a code review assistant checking whether a stated fact 
        is consistent with the conversation that produced it.
        Return ONLY a JSON object: {"coherent": boolean, "confidence": float, "reason": string}

User: Fact claimed: {fact_json}
      Conversation excerpt that produced this fact: {surrounding_turns}
      Is this fact logically consistent with the conversation?
```

**Confidence ≥ 0.85:** Mark fact as `UNVERIFIED` (no change) and allow injection with an `UNVERIFIED` tag in the context prefix.

**Confidence < 0.85:** Escalate to Tier 3 (Opus).

### Cost Control

Llama spot-check runs on 10% of UNVERIFIED facts (random sample). The other 90% are injected as UNVERIFIED without spot-check. This is acceptable because:
- UNVERIFIED facts are already labeled as such in context
- The LLM can reason about the uncertainty
- Git-Attestation already confirmed there's no direct contradiction

The 10% sample provides statistical confidence in the system without auditing every fact.

---

## Tier 3 — Opus Escalation (High-Accuracy)

Triggered only when Llama confidence < 0.85. This should be rare — targeting < 1% of all facts processed.

### What It Does

Sends the same prompt to Claude Opus with a larger context window and more explicit reasoning instructions:

```
System: You are auditing an AI memory system. A fact was extracted from 
        a conversation and the automated confidence check flagged it as 
        potentially unreliable. Determine whether this fact should be 
        CONFIRMED, UNVERIFIED, or SUPPRESSED.
        
        SUPPRESSED means the fact is likely false and should not be 
        injected into future AI context. This is a serious action — 
        only suppress if you have high confidence the fact is wrong.
        
        Return ONLY: {"verdict": "CONFIRMED"|"UNVERIFIED"|"SUPPRESSED", 
                      "confidence": float, "reasoning": string}

User: Fact under review: {fact_json}
      Full conversation that produced this fact: {full_session_excerpt}
      Git history for relevant entities: {git_context}
```

### Cost Budget

Opus escalation must not exceed 2% of CQ revenue. Monitor monthly:

```sql
SELECT 
  SUM(opus_audit_cost_usd) as monthly_opus_cost,
  SUM(cq_fee_usd) * 0.02 as audit_budget,
  CASE WHEN SUM(opus_audit_cost_usd) > SUM(cq_fee_usd) * 0.02 
       THEN 'OVER BUDGET' ELSE 'OK' END as status
FROM billing_records
WHERE created_at > NOW() - INTERVAL '30 days';
```

If over budget, lower the Llama confidence threshold (from 0.85 toward 0.90) to reduce escalations.

---

## Audit Decision Flow

```
New fact extracted from session
          │
          ▼
    Is fact code-related?
    ┌─────┴─────┐
   YES          NO
    │            │
    ▼            ▼
Git-Attest    Skip to injection
    │          (UNVERIFIED)
    ├── CONFIRMED → inject with CONFIRMED tag
    ├── CONFLICT  → suppress, log conflict, alert developer
    └── UNVERIFIED
              │
              ▼
         Sample (10%)?
         ┌────┴────┐
        YES        NO
         │          │
         ▼          ▼
    Llama check   inject as UNVERIFIED
         │
    confidence ≥ 0.85?
    ┌────┴────┐
   YES        NO
    │          │
    ▼          ▼
 inject    Opus audit
 UNVERIFIED    │
         ┌─────┴──────┐
    CONFIRMED  UNVERIFIED  SUPPRESSED
         │          │          │
       inject    inject     suppress
       confirmed  unverified  + log
```

---

## Context Injection Format

When a fact is injected into context, it is formatted as structured JSON, not prose:

```
[CQ-MEMORY: CONFIRMED via commit a3f9b2d]
{"type":"FunctionChange","old":"getUser","new":"fetchUser","timestamp":"2026-01-15T14:23:00Z"}
[/CQ-MEMORY]

[CQ-MEMORY: UNVERIFIED - treat with appropriate uncertainty]
{"type":"TechDecision","decision":"Switched from Redis to Dragonfly for session cache","domain":"infrastructure"}
[/CQ-MEMORY]
```

The structured format ensures the LLM receives typed data, not a narrative that could be misinterpreted.

---

## Historical Drift Alerts

When a CONFLICT is detected, the developer is notified immediately via:

1. **Dashboard alert:** Red banner on `localhost:4080/dashboard`
2. **CLI warning:** Printed to the terminal session where Claude Code is running
3. **Supabase log:** Written to `audit_conflicts` table with full detail

```typescript
interface AuditConflict {
  id: string;
  detected_at: number;
  session_id: string;
  fact_id: string;
  fact_type: FactType;
  claimed_state: string;       // what the fact claimed
  actual_state: string;        // what Git says
  conflict_commit: string;     // the commit that contradicts the fact
  suppressed: boolean;         // always true for CONFLICT
}
```

The alert message shown to the developer:

```
⚠️  CQ Historical Drift Detected
    
    Fact: "fetchUser() was introduced in commit a3f9b2d"
    Conflict: fetchUser() was deleted in commit c7d1e4f (2026-03-02)
    
    This memory has been suppressed and will not be injected into context.
    
    Recommended action: Review your codebase state for function 'fetchUser'.
```
