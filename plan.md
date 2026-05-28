# DevOPs + Stratum — Masterpiece Execution Plan

**Owner**: Milton Adina
**Authored**: 2026-05-28 (paired with `blueprint.md`)
**Quality bar**: **Best-of-the-best at every layer.** No exceptions. The "personal use" framing means no Stripe billing yet — it does NOT relax quality, coverage, security, or rigor.
**Format**: GitHub-style `- [ ]` checklist. Group order = recommended execution order.
**Distribution model**: private repo today → friends-install tomorrow (v0.4.x+) → commercial v1.0.0+. Every line is built for the friend-install + commercial-future case.

**Status snapshot (2026-05-28)**:
- `main` at `3d268e2` (Session 13 Phase C merged)
- `stratum-phase-0-capture` at `2496c4a` (P0-A complete; OPEN, no PR — PR opens at full Phase 0 acceptance)
- `v0.2.0` tag at `aca4982` (sealed)
- Validator: 93/94 valid (claim 076 coupled to PB-13)
- Polish backlog: 16/18 closed; 2 user-side open (PB-13 billing, PB-16 signing-key)

---

## 0. Standing rules (apply to every checkbox below)

- **PR-flow per PB-17 Option β** for every change to `main`. Squash-merge via `gh pr merge --squash --delete-branch`. No direct commits. (Long-lived working branches like `stratum-phase-0-capture` stay open and PR at full phase acceptance.)
- **Claim-validator stays at 94/94 (or 93/94 max with PB-21-coupled-to-PB-13 documented exception).** Any new claim must run cleanly.
- **Coverage thresholds binding**: statements ≥85%, branches ≥80%, functions ≥90%, lines ≥85% on production code paths.
- **Every shipped skill Sigstore-signed.** `release-sign.yml` must run cleanly (depends on PB-13 closure).
- **Every release git-tag GPG-signed.** Depends on PB-16 closure.
- **AP-5 surfacing**: Proof Theater, Reflexive Patch, Scheduler-Failure are honest-stop conditions. Surface immediately, don't paper over.
- **Read-all-first-then-Write** before edit batches.
- **JS regex no PCRE.** `[\s\S]` for multiline.
- **Per stratum CLAUDE.md**: TypeScript strict, no `any`, JSDoc on exports, no `.unwrap()` in Rust production paths.
- **EARS specs before non-trivial code.** Spec → claim → implementation → claim → proof.

---

## 1. v0.2.x → v0.3.x prerequisites (closes carry-forward; user-side actions)

These unblock the trust-chain story. Do these BEFORE starting Phase 0 corpus capture.

### 1a. PB-13 closure (GitHub Actions billing — user-side)

- [ ] **User-side**: Navigate to https://github.com/settings/billing/spending_limit. Set a non-zero spending limit on that specific page.
- [ ] **User-side**: Confirm in chat the exact value set (e.g., "spending-limit set at github.com/settings/billing/spending_limit to $10").
- [ ] **Agent (dedicated session)**: dispatch `release-sign.yml --ref v0.2.0`. Monitor run. If `conclusion=success` AND `steps>0` AND duration >10s → cosign verify-blob → close PB-13 + PB-21 (PB-21 closes-with-PB-13). If failure → AP-5 Scheduler-Failure pattern check, surface honestly, do not retry without new signal.

### 1b. PB-16 closure (git tag signing — user-side)

- [ ] **User-side**: generate a GPG (or SSH) signing key. Upload public key to GitHub's signing-keys settings. Note the fingerprint.
- [ ] **User-side**: confirm in chat the fingerprint + key type.
- [ ] **Agent (dedicated session or part of v0.3.0 release)**: configure `git config user.signingkey <fingerprint>` + `git config tag.gpgsign true`. Cut a test tag `v0.2.1-test` with `-s`; verify `git tag -v v0.2.1-test` shows good signature. Delete test tag. Update PERSONAL_USE.md with the signing flow.

### 1c. Session-handoff entry (gitignored, agent-side)

- [ ] Append Session 14 entry to `.workflow/state/session-handoff.md`: "Personal-use re-affirmation with masterpiece quality bar — Session 13's production-grade rigor stays binding; only Stripe-integration half of Phase 6 deferred to v1.0.x. blueprint.md is the source-of-truth from Session 14 forward." Do NOT revise Session 13's entry — supersede forward.

---

## 2. v0.3.x — Phase 0 complete + Phase 1 measurement proxy

**Theme**: "I run Claude Code through my proxy and see real numbers."
**Ship gate**: friend can clone + setup + see live dashboard with token counts on real traffic; coverage thresholds met.
**Effort remaining**: ~90h.

### 2a. Phase 0 code-side gaps (~6h)

- [ ] **Q4 base-URL wiring** (~30 min). Edit `stratum/scripts/capture-session.ts:144`. Replace hardcoded `"https://api.anthropic.com/v1/messages"` with `` `${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages` ``. Verify by running the 2 `test.todo` cases in `stratum/test/capture-session/config-resolution.test.ts` after flipping them to real assertions.
- [ ] **P0-F PII redaction wiring** (~3h, SECURITY-BEARING). Wire `observability/pii-redaction.ts` into `capture-session.ts`. Redact (a) request body (messages content + system + tool inputs), (b) response body (assistant text), (c) per-message breakdown content before adding to capture artifact. Use FAIL-CLOSED semantics: redactor throws → drop the captured turn from session JSON + log structured stderr error. Flip the 3 `test.todo` cases in `stratum/test/capture-session/pii-redaction-passthrough.test.ts` to passing assertions covering: planted email redacted, planted JWT redacted, redactor-exception drops turn.
- [ ] **Anthropic SDK version verification** (~1h). The current `@anthropic-ai/sdk` pin is `^0.39.0`. Check current published version. Bump to latest stable; run vitest suite; if breaking changes → fix in capture-session.ts; add ADR `stratum/docs/decisions/0008-sdk-version-pin.md`.
- [ ] **Adversarial test additions** (~1.5h). Add to `stratum/test/capture-session/`: `injection-resilience.test.ts` (try to inject `[REDACTED-email]` into a message to verify it isn't double-redacted), `partial-response.test.ts` (truncated Anthropic response), `oversized-payload.test.ts` (>1MB request body — must not crash).

### 2b. Phase 0 content corpus (user-side, ~12h)

- [ ] **5+ real session captures** (~1 week of normal Claude Code use). Process: `cd stratum && npm install && npm run capture` in one terminal; in Claude Code terminal `export ANTHROPIC_BASE_URL=http://localhost:4090`; do normal work; Ctrl+C the capture when done. Repeat across ≥5 different projects/contexts (different stacks: web/server, scripts, refactors, debugging). Files land in `stratum/data/sessions/session-<uuid>.json`. NOTE: this is YOUR data, gitignored.
- [ ] **Fill `stratum/docs/waste-taxonomy.md`** (~3h analysis). Read the 5+ captured JSON files. Identify ≥4 named waste categories (e.g., system prompt repetition, tool output echoes, redundant reasoning traces, full-file re-reads). Fill all 23 `<!--` markers. **Critical**: answer "#1 Waste Type" at line 119 — this is the load-bearing finding driving Phase 2 pruner heuristics.
- [ ] **DyCP paper notes** (~4h reading + writing). Read arXiv:2601.07994 (Dynamic Context Pruning for Long-Form Dialogue with LLMs). Fill `stratum/docs/paper-notes.md` (currently a stub). Write ≥5 substantive notes covering: algorithm summary, key parameters (θ, decay λ), benchmark results on LoCoMo + MT-Bench+, failure cases the paper documents, and our adaptation choices (specifically what CQ-Extended changes vs vanilla DyCP).

### 2c. Phase 0 closure

- [ ] **Emit claim 096 (Phase 0 acceptance)**. spec_ref: `.workflow/state/plans/stratum-phase-0-capture.md`. Anchors: 5+ session JSONs, waste-taxonomy.md content-complete, paper-notes.md with ≥5 notes, capture-session.ts diff line 144 + PII wiring landed, all 5 test.todos flipped to passing.
- [ ] **Phase 0 retrospective** (~30 min) in baton.md: what surprised me about my own token waste? Does the #1 waste finding suggest Phase 2 pruner priorities differ from spec?

### 2d. Phase 1 measurement proxy buildout (~80h)

- [ ] **Promote capture script to real Fastify proxy** (~15h). Create `stratum/src/proxy/index.ts` with proper route registration, lifecycle hooks (preHandler/onSend/onResponse), graceful shutdown (SIGTERM drains in-flight + flushes captures), `/health` endpoint, error handling middleware.
- [ ] **Wire `@fastify/rate-limit`** (~2h). Currently in deps but not used. Configure: 100 req/min default per IP for the proxy; configurable via env. Add test.
- [ ] **Anthropic API retry/backoff** (~3h). 429 → exponential backoff per Anthropic-recommended retry-after header. 5xx → 3 retries with jitter. Network error → 1 retry then surface to client. Test against fixtures.
- [ ] **Streaming response handling (P0-B work, ~18h)**. Detect `stream: true` in request body OR `Accept: text/event-stream` header. Forward to Anthropic with streaming enabled. Parse SSE events. Forward chunks to client preserving streaming semantics (don't buffer-and-respond). Accumulate full session JSON from event sequence (`message_start` → `content_block_*` × N → `message_delta` → `message_stop`). Handle: network drop mid-stream, malformed chunks, client AbortController, Anthropic-side error events. Use `axios` with `responseType: 'stream'` (per blueprint note: keeps HTTP transport unified). Test fixtures at `stratum/test/fixtures/anthropic-streams/*.sse`: simple-text-stream, tool-use-stream, mixed-content-stream, multi-turn-stream, abort-mid-stream, network-drop, anthropic-error-event, malformed-chunks.
- [ ] **Exact token counting hardening** (~5h). Per Q2: `client.messages.countTokens()` per turn. Cache for repeated identical-message-array counts (hash-keyed). Fallback path if countTokens API errors: use `@anthropic-ai/tokenizer` AND flag `token_count_method: "estimated"` in turn JSON. NEVER silently estimate.
- [ ] **Waste detection heuristics** (~10h). Implement ≥4 heuristics derived from Phase 0 #1 waste finding + taxonomy. Each heuristic: pure function `detect(session: CapturedSession): WasteFinding[]`. Each finding has type, severity, token_estimate, location. Unit tested.
- [ ] **Dashboard at `/dashboard`** (~12h). Static HTML + JSON API (no React/Next bloat). Show: today's session count, total tokens consumed, tokens by category (input/output/tool), $ estimate, top-5 waste findings, real-time session-in-progress view. Vanilla CSS, server-side rendered. Mobile-responsive.
- [ ] **Supabase local wiring** (~6h). `supabase start` from `stratum/`. Apply migration `20260406000000_initial_schema.sql` (already exists). Wire writes from proxy to `sessions` table. Test with `supabase db reset` + capture session + verify row.
- [ ] **OTel span instrumentation** (~4h). Spans for every proxy request. Attributes: `stratum.input_tokens`, `stratum.output_tokens`, `stratum.model`, `stratum.elapsed_ms`, `session.id`, `turn.number`. NEVER include `messages` content (PII). Soft dep per Q7: empty `OTEL_EXPORTER_OTLP_ENDPOINT` → stderr fallback; no crash.
- [ ] **Integration tests** (~5h). vitest tests against the real Fastify instance via `app.inject()`. Cover: happy path, all 4 error paths (4xx/5xx/network/malformed), streaming round-trip, rate-limit triggers, OTel emission, Supabase write success/failure.
- [ ] **Coverage gate enforcement** (~ongoing). Run `npx vitest run --coverage` before every claim emission. All 4 thresholds must hold on `stratum/src/proxy/*` + `stratum/scripts/capture-session.ts`.
- [ ] **PERSONAL_USE.md v1** (~3h). Daily workflow: how to start the proxy, env vars, dashboard URL, troubleshooting, where artifacts live, how to clean up.

### 2f. First-party Anthropic integrations (NEW — Session 14 addition)

- [ ] **Wire `anthropics/claude-code-security-review` GitHub Action** (~2h). Create `.github/workflows/claude-security-review.yml`. SHA-pin the action per AST08 (look up latest release; pin to commit SHA, comment with version). Run on every PR to `main`. Configure to post inline review comments. Verify on a test PR (small typo + a fake SQL-injection sample) that comments land. Add ADR `governance/decisions/ADR-014-claude-security-review-integration.md` (or appropriate location).
- [ ] **Document Claude Code `/code-review` in PR-flow** (~1h). Update `CONTRIBUTING.md` + DEVELOPER_GUIDE.md (when it lands in v0.8.x) with the per-PR review checklist: (a) `/code-review` for diff correctness, (b) `/security-review` for security (or wait for the GitHub Action if going via PR), (c) `npm run validate:claims -- --all` for proof re-runs, (d) any threat-model-touch triggers the threat-model lint.
- [ ] **Slash command surface check** (~30 min). Verify our existing `slash-commands/universal/security-scan.md` + `slash-commands/universal/verify-claims.md` complement (not conflict with) Anthropic's `/security-review` + `/code-review`. If name-collision, rename ours to `/security-scan-tiered` or similar. Document in slash-commands README.

### 2g. Borrowed pattern integration — TDD red/green explicit (NEW)

- [ ] **Make red/green TDD explicit in constitution** (~1h, doc-only). Add to `constitution/PRINCIPLES.md` an explicit "Red/Green TDD" principle borrowed from obra/superpowers. Already implied by our proof-of-work + claim-validator discipline; this just makes it explicit so subagents inherit it. Cite source in the principle's footnote.

### 2h. v0.3.0 release

- [ ] **PR `stratum-phase-0-capture` → `main`** (~1h). Squash-merge. Linear history maintained.
- [ ] **Cut v0.3.0 tag** with `git tag -s v0.3.0 -m "v0.3.0 ..."` (depends on PB-16 closure).
- [ ] **release-sign.yml dispatches** signed cosign artifacts (depends on PB-13 closure).
- [ ] **Update LAUNCH_READINESS.md** with v0.3.0 ship math + the new "to v1.0.0" math.
- [ ] **GitHub Release** with release notes (Keep-a-Changelog format).
- [ ] **CHANGELOG.md update** at repo root.

---

## 3. v0.4.x — Phase 2 KadaneDial Pruner

**Theme**: "My Claude Code costs went down 30-50% without quality loss."
**Ship gate**: Eval suite GREEN; zero Tier C regressions; 1 week real-use confirms no degradation.
**Effort remaining**: ~120h.

### 3a. Pre-requisites

- [ ] v0.3.0 shipped and stable.
- [ ] ≥20 real captured sessions in `stratum/data/sessions/` (for Tier B eval scenarios).

### 3b. Pruner core

- [ ] **ONNX bi-encoder model selection + export** (~6h). Start with `sentence-transformers/all-MiniLM-L6-v2` INT8. Export to `stratum/models/all-MiniLM-L6-v2-int8.onnx`. Benchmark: <10ms p99 on local hardware.
- [ ] **`stratum/src/pruner/encoder.ts`** (~8h). ONNX inference wrapper using `onnxruntime-node` (already in deps). Async API. Pooled-mean output. Unit tested.
- [ ] **`stratum/src/pruner/kadanedial.ts`** (~25h). CQ-Extended KadaneDial algorithm per `stratum/docs/ALGORITHM.md`. Time-based decay (`λ^((now - timestamp_i) / 3600)`), NOT turn-count. Relevance formula: `R_i = (S_i - g) * λ^((now - timestamp_i) / 3600)` where `S_i` is z-score normalized cosine similarity. Log every pruning decision (pruned turns, scores, gain threshold). Unit tested with synthetic + real data.
- [ ] **`stratum/src/pruner/pruner.ts`** (~6h). Orchestrator combining encoder + KadaneDial. Single-call interface. Integrated logging.
- [ ] **`stratum/src/pruner/crypto.ts` stub** (~2h). Empty stub for Phase 4 client-side encryption hook-points. Document interface; don't implement yet.

### 3c. Eval harness

- [ ] **Tier A datasets** (~15h). Port or download LoCoMo + MT-Bench+ + SCM4LLMs to `stratum/evals/datasets/`. Document acquisition + license per dataset.
- [ ] **`stratum/evals/harness/runner.ts`** (~10h). Eval orchestrator: load dataset → run pruner → compute Faithfulness (DeepEval) + Answer Relevancy + Latency. Output JSON results per run.
- [ ] **Tier A baseline run** (~3h). Full-context (no prune) baseline. Save as `stratum/evals/results/tier-a-baseline.json`.
- [ ] **Tier A pruner run** (~3h). With pruner enabled. Save as `stratum/evals/results/tier-a-pruner.json`. Verify Faithfulness >0.90 + Answer Relevancy >0.88 vs baseline.
- [ ] **Tier B scenarios** (~12h). ≥4 developer workload scenarios derived from your real Phase 0 corpus: e.g., long debugging session, refactor across 5 files, multi-day project resume, deep stack-trace analysis.
- [ ] **Tier C golden queries** (~8h). ≥30 critical queries that must NEVER regress (e.g., "what version of vitest are we using" if facts say 2.1.0 must return 2.1.0). Encoded as input/expected-substring pairs.
- [ ] **`npm run test:eval` wires** all three tiers into one command. CI runs Tier C on every PR; Tier A weekly; Tier B on Phase 2-touching PRs.

### 3d. Pruner integration into proxy

- [ ] **Feature flag** (~2h). `prune_enabled: false` by default in `config.yml`. Shadow-mode option: compute prune decision but don't apply.
- [ ] **Wire into Phase 1 proxy** (~6h). Pruner runs after token counting, before forward. Pruned messages forwarded to Anthropic. Original messages still in capture artifact + session JSON.
- [ ] **Dashboard pruner metrics** (~5h). Original tokens, pruned tokens, prune ratio, $ saved, prune decision log viewer.
- [ ] **One week shadow-mode use** (manual). Confirm decisions look sane on real workflow before flipping flag on.
- [ ] **Flip to live mode + monitor 1 week**. Confirm no AI quality degradation.

### 3e. v0.4.0 release

- [ ] PR + squash-merge to main.
- [ ] Signed v0.4.0 tag.
- [ ] LAUNCH_READINESS + CHANGELOG update.
- [ ] GitHub Release with eval results attached.
- [ ] Update PERSONAL_USE.md with pruner enable/disable docs.

### 3f. Borrowed pattern integration — subagent-driven-development (NEW, ~15h)

Borrowed from [obra/superpowers](https://github.com/obra/superpowers). Extends our existing subagents (`subagents/universal/{planner,coder,reviewer,tester,security,validator,researcher}.md`) with explicit autonomous-loop semantics. Folded into v0.4.x because Phase 2 pruner work is the right vehicle to prove the loop (it's complex, multi-stage, eval-gated — exactly the workflow that benefits from autonomous subagents).

- [ ] **Subagent autonomous-loop pattern doc** (~3h). New file `subagents/AUTONOMOUS_LOOP.md`: spec → plan → assign tasks → subagent works → inspect → review → continue → eval-gate. Adapt superpowers' rhythm to our claim-validator discipline (every subagent-completed unit emits a claim with a proof script).
- [ ] **Extend `planner.md` subagent** (~2h) to produce implementation plans "clear enough for an enthusiastic junior engineer with poor taste, no judgment, no project context, and an aversion to testing to follow" (verbatim superpowers framing — apt for our quality bar).
- [ ] **Extend `coder.md` subagent** (~2h) to enforce TDD red/green + YAGNI + DRY explicitly. Surface tests-first as a hard constraint.
- [ ] **Extend `reviewer.md` subagent** (~3h) to inspect each completed unit before signoff. Hooks into our existing claim-validator + Anthropic `/code-review`.
- [ ] **Add `orchestrator.md` subagent** (~3h) to manage the autonomous loop. Owns the spec → plan → assign → inspect cycle. Bounded by token budget (cost-controls/budget.yml) and time budget per cycle.
- [ ] **Pilot the autonomous loop** on one Phase 2 sub-task (eval harness scenario authoring is a good fit — repetitive, structured) (~2h pilot + retrospective). Document outcomes + lessons in baton.md.

---

## 4. v0.5.x — Phase 3 Three-Tier Memory (Hot / Warm / Cold)

**Theme**: "Stratum remembers what we decided. I never re-explain decisions."
**Ship gate**: fact-survives-50-turn-gap test passes; Tier 2 <50ms p95; Tier 3 Pinecone <150ms p95; Neo4j <80ms; Zod gates all writes.
**Effort remaining**: ~100h.

### 4a. Tier 1 — Hot Memory (rolling window)

- [ ] **`stratum/src/memory/hot/tier1.ts`** (~10h). In-memory rolling window per active session. Configurable window size (default: last 50 turns). Cloudflare Durable Object compatible (when CF deployment lands in v1.0.x).
- [ ] **Tier 1 query API** + tests.

### 4b. Tier 2 — Warm Memory (Supabase facts + Llama extractor)

- [ ] **Five fact-type Zod schemas** (~8h) at `stratum/src/types/facts.ts`: FunctionChange, TechDecision, PolicyUpdate, Todo, VariableChange. Per spec §3 + TECHNICAL_SPEC.md. All have: `id uuid`, `created_at timestamptz`, `session_id uuid`, `commit_hash text nullable`, `confidence_score float`, `is_verified bool`, `is_suppressed bool`, plus fact-type-specific fields.
- [ ] **Supabase migration** (~3h) for `facts` table. New file `stratum/supabase/migrations/20260601000000_facts_table.sql`.
- [ ] **`stratum/src/memory/warm/extractor.ts`** (~25h). Llama-based fact extractor. Use local Ollama (recommended) or Anthropic Haiku at low cost. Per Stratum CLAUDE.md: Llama 4-8B confidence-based extraction; never write to DB if Zod fails.
- [ ] **`stratum/src/memory/warm/tier2.ts`** + query API (~8h). Read-side: get facts by project, by session, by fact-type, top-N by confidence.
- [ ] **Tier 2 latency test** (~2h). Confirm <50ms p95 query latency on 10,000-fact dataset.

### 4c. Tier 3 — Cold Memory (Pinecone + Neo4j)

- [ ] **`stratum/src/memory/cold/pinecone.ts`** (~15h). Embedding model selection + indexing strategy + upsert + query. Per spec: cosine similarity over fact embeddings; top-N retrieval.
- [ ] **`stratum/src/memory/cold/neo4j.ts`** (~15h). Graph schema per Stratum CLAUDE.md: nodes `Function`, `Commit`, `Decision`, `Developer`, `Policy`; edges `DEPRECATED_BY`, `REFERENCED_IN`, `SUPERCEDES`, `AUTHORED_BY`, `APPLIES_TO`. Graph write API + query API.
- [ ] **Tier 3 latency tests** (~3h). Pinecone <150ms p95; Neo4j <80ms (function status query).

### 4d. Promotion + integration

- [ ] **Nightly Tier 2 → Tier 3 promotion job** (~8h). Cron-style script (or scheduled GitHub Action) that promotes high-confidence Tier 2 facts to Tier 3. Idempotent.
- [ ] **DevOPs session-start hook integration** (~8h). Extend `hooks/universal/session-start/load-baton.sh` to query Stratum facts: current project's recent Tier 2 facts + Tier 3 semantic search for current task context. Inject top-N facts into agent context via constitution layer.
- [ ] **Tier B eval scenario**: fact-survives-50-turn-gap (~3h). Inject FunctionChange in session A; 50 turns of unrelated work in session B same project; query → fact returned correctly.

### 4e. v0.5.0 release

- [ ] PR + squash-merge.
- [ ] Signed tag.
- [ ] LAUNCH_READINESS + CHANGELOG.
- [ ] GitHub Release with memory architecture diagram.
- [ ] Update PERSONAL_USE.md + ARCHITECTURE.md with memory subsystem.

### 4f. Borrowed pattern integration — knowledge-graph view (NEW, ~30h)

Borrowed from [Lum1104/Understand-Anything](https://github.com/Lum1104/Understand-Anything). Layers a visualization + exploration UI on top of Phase 3's existing Neo4j graph store (which is already in scope). The graph DB was always going to be there; this adds the UI + tour generation + semantic search on top.

- [ ] **Knowledge-graph extraction pipeline** (~10h). Multi-agent code-analysis pipeline: walk the project's files; extract functions, classes, dependencies; cross-reference with Tier-2 facts (decisions, deprecations); write graph nodes + edges to Neo4j (already wired in Phase 3). One agent per node-type for parallelizable processing.
- [ ] **`/understand-codebase` slash command** (~3h). New command at `slash-commands/universal/understand-codebase.md`. Triggers the extraction pipeline on the current repo. Output: graph file + dashboard URL.
- [ ] **Dashboard `/dashboard/graph` view** (~10h). Interactive graph viewer (vanilla JS + d3.js or sigma.js; no React bloat). Pan, zoom, click-to-expand. Sidebar shows node details: file path, plain-English summary (generated by subagent), relationships, related Tier-2 facts.
- [ ] **Fuzzy + semantic search across the graph** (~4h). Fuzzy (string-distance over node names) + semantic (Pinecone-backed embedding search over node summaries — Pinecone is already in Phase 3 scope).
- [ ] **Auto-generated guided tours** (~3h). For a new contributor: tour the project in dependency order. Generate tour ordering from the graph topology (topological sort); narrate each stop with the node's plain-English summary.
- [ ] **(Future, defer)** Karpathy-pattern wiki support (`/understand-knowledge`). Useful when memory matures. Tracked but not in v0.5.x scope.

---

## 5. v0.6.x — Phase 5 Git-Attestation Audit Engine

**Theme**: "Stratum's memory is trustworthy because it's cross-checked against Git history."
**Ship gate**: contradicting fact → CONFLICT in <5s; Opus escalation <1% of facts in 1000-fact test; Llama spot-check confidence-flagging works.
**Effort remaining**: ~60h.

### 5a. Git indexer + attestation checker

- [ ] **`stratum/src/audit/git-indexer.ts`** (~12h). Incremental git log indexer. <5s for last 100 commits. Output: structured commit + diff records for downstream attestation.
- [ ] **`stratum/src/audit/git-attestation.ts`** (~15h). For each Tier 2 fact, fetch commit_hash from indexer, compare claimed fact against actual git state. Output: CONFIRMED / CONFLICT / UNVERIFIABLE.
- [ ] **Tests**: inject contradicting `FunctionChange` fact → CONFLICT; inject correct fact → CONFIRMED; missing commit_hash → UNVERIFIABLE.

### 5b. Llama spot-check + Opus escalation

- [ ] **`stratum/src/audit/llama-check.ts`** (~8h). 10% random sample of facts; Llama coherence check; output confidence score.
- [ ] **`stratum/src/audit/opus-escalation.ts`** (~8h). When Llama confidence <0.85, escalate to Opus for deeper analysis. Log decision + reasoning.
- [ ] **Cost monitor**: log Opus audit costs; alert if >2% of usage. (~3h)

### 5c. audit_conflicts table + dashboard alerts

- [ ] **Supabase migration** for `audit_conflicts` table (~2h). Already in initial schema; verify.
- [ ] **CONFLICT alert pipeline** (~4h). New conflict → write to audit_conflicts → dashboard "Historical Drift" alert within 5s.
- [ ] **Dashboard updates** (~5h). Audit-conflicts panel; per-fact CONFIRMED/CONFLICT/UNVERIFIABLE badge.

### 5d. v0.6.0 release

- [ ] Eval: inject 100 facts (mix of correct + contradicting + ambiguous); expect ~10% Llama spot-checked; <1% Opus-escalated; all CONFLICTs surface in dashboard within 5s.
- [ ] PR + squash-merge + signed tag + release artifacts + docs.

---

## 6. v0.7.x — Phase 4 ZK-Context + AWS Nitro TEE

**Theme**: "I can use Stratum with NDA-sensitive code without leaking plaintext."
**Ship gate**: modified-PCR enclave rejected; latency <15ms added; raw context audit shows zero plaintext in any log/table; independent security reviewer signs off.
**Effort remaining**: ~80h. **Highest-risk component**; build last so the rest is mature.

### 6a. Client-side crypto

- [ ] **`stratum/src/pruner/crypto.ts`** (~15h). AES-256-GCM. Per-session key derived via HKDF from operator master key. Authenticated encryption. Tested against NIST vectors.
- [ ] **Key rotation flow** (~3h). Session-end hook rotates session key. Already in `hooks/universal/session-end/rotate-session-key.sh`; verify.

### 6b. AWS Nitro Enclave deployment

- [ ] **Enclave application** (~20h). Decryption-only inside enclave. Build + sign + measure PCR values. Publish expected PCRs per release at `stratum/docs/enclave-pcr-values.md` (template already exists).
- [ ] **Attestation flow** (~12h). Client verifies PCR measurements before any decryption. Reject mismatched PCRs.
- [ ] **TEE Gateway** (~15h). Proxy routes ZK-enabled requests through enclave. Per-org `zk_enabled` config toggle.

### 6c. Audit gates

- [ ] **Modified-enclave test** (~3h). Build enclave with wrong PCR; attestation MUST reject.
- [ ] **Log audit** (~2h). Grep all Cloudflare/Supabase/OTel outputs for plaintext context patterns; expect zero matches.
- [ ] **Latency benchmark** (~3h). TEE overhead must be <15ms p99 on the request path.
- [ ] **Independent security reviewer** (~ongoing) — reads `stratum/docs/SECURITY.md`; signs off on threat model.

### 6d. Claude Code Security (reasoning-based) integration at release gate (NEW, ~4h)

Anthropic's reasoning-based security scanner (GA Feb 2026) reads code "the way a human security researcher would" — traces data flow, catches complex vulns that pattern-matchers miss. Wire it as a release-gate scan before any v0.x → v0.(x+1) tag from v0.7.x forward. Especially load-bearing around the TEE boundary + Phase 3 fact-extraction paths.

- [ ] **Wire Claude Code Security at release gate** (~2h). Run on the full diff between previous release tag and current release candidate. Document the run in release notes. Surface findings (if any) with disposition (fix-before-release / accept-risk-with-ADR / false-positive-with-rationale).
- [ ] **Data-flow tracing focus areas** documented in `stratum/docs/SECURITY.md` (~1h). Explicitly call out the high-value scan targets: TEE boundary (encrypt/decrypt code paths), Phase 3 fact extractor (LLM-input/output boundary), PII redaction wrapper (any new code touching captured content), proxy forward path (auth header handling).
- [ ] **Threat-model entry update** (~1h) — add reasoning-based scan as a Tier 3 control alongside existing pattern-based scans (gitleaks + semgrep) and our area-A pentest-stack.

### 6e. v0.7.0 release

- [ ] PR + squash-merge + signed tag + release artifacts + threat-model entry + ADR.

---

## 7. v0.8.x — Polish + operator-readiness

**Theme**: "A friend with a fresh laptop can install this in <5 minutes."
**Ship gate**: cold-clone-to-running in <5 min on a clean macOS + Linux + WSL2 laptop; backup + restore tested on real data.
**Effort remaining**: ~50h.

### 7a. Onboarding

- [ ] **`npm run setup`** (~15h). One-command setup script at repo root. Detect OS; install Supabase local (Docker required); install Stratum deps; configure env vars; smoke-test proxy startup; output success message with next steps. Cross-platform (macOS / Linux / WSL2).
- [ ] **PERSONAL_USE.md v2** — full polish (~5h). Daily workflow, env vars, troubleshooting common errors, FAQ.
- [ ] **DEVELOPER_GUIDE.md** (~6h). For friends contributing: dev environment setup, test running, lint/format, PR conventions, signing setup (PB-16 closed).
- [ ] **ARCHITECTURE.md** (~6h). System design overview. Diagrams. Component responsibilities. Data flow. Cross-reference to ADRs.

### 7b. Observability + ops

- [ ] **Sentry error tracking integration** (~4h). DSN configurable via env. PII-redaction wrap on error events. Free tier OK for personal use.
- [ ] **Grafana / Langfuse dashboards** (~6h). OTel → Grafana for proxy metrics; Langfuse for LLM observability. Dashboards exported as JSON in `observability/dashboards/`.
- [ ] **Performance benchmark suite** (~5h). Latency p50/p99 tracked per release. Regression detection on PR (>20% slower = fail).
- [ ] **Runbooks** (~5h). Incident response, backup/restore, common operational tasks. In `docs/runbooks/`.

### 7c. Data + config

- [ ] **Multi-environment config** (~4h). `config.dev.yml` / `config.prod.yml` overrides. Document in PERSONAL_USE.md.
- [ ] **Versioned schema + migration scripts** (~4h). `stratum/scripts/migrate-session-schema.ts` (already in Phase 0 spec). Test v0.1.0 → v0.2.0 round trip.
- [ ] **Backup + restore** (~5h). Document Supabase export/import + Stratum data backup. Test end-to-end recovery.
- [ ] **Telemetry policy + opt-out** (~3h). What does Stratum emit? Where? Where's `STRATUM_TELEMETRY_OPT_OUT=true`? Documented in PERSONAL_USE.md + new `TELEMETRY.md`.

### 7d. Distribution polish

- [ ] **Plugin marketplace metadata** (~2h). Verify `.claude-plugin/marketplace.json` is current.
- [ ] **License clarity** (~2h). MIT vs Apache vs custom. Decide. Update LICENSE + headers if needed.
- [ ] **CONTRIBUTING.md polish** (~3h). Reflect friend-contribution + future-commercial framing. Reference DEVELOPER_GUIDE.md.

### 7e. v0.8.0 release

- [ ] PR + squash-merge + signed tag + release artifacts + full docs landed.

---

## 8. v0.9.x — Phase 6 billing schema (no Stripe yet)

**Theme**: "Forward-compat for v1.0.x commercial."
**Ship gate**: cannot modify a billing record (Postgres trigger test passes); GDPR erasure <30s on 1-year data; schema ready for Stripe wiring.
**Effort remaining**: ~30h.

- [ ] **`stratum/src/billing/recorder.ts`** (~10h). HMAC-SHA256-signed `BillingRecord` writes. Append-only.
- [ ] **Append-only Postgres trigger** (~3h). UPDATE/DELETE on `billing_records` table → raise exception. Test: attempt UPDATE → expect exception.
- [ ] **`stratum/src/billing/calculator.ts`** (~5h). Per-record + monthly aggregate calculations. `0.20 × (original - quarantined) × price` formula (placeholder; not active until Stripe).
- [ ] **`stratum/src/billing/invoice.ts` stub** (~3h). Interface only; no Stripe yet. Implementable when v1.0.x customer arrives.
- [ ] **GDPR erasure endpoint** (~5h). Anonymizes billing records (keeps financial total, removes PII). <30s on 1-year history. Tested.
- [ ] **CFO dashboard skeleton** (~3h). Read-only view of billing schema; no real billing data yet. Hidden behind `DASHBOARD_CFO_VIEW=true` env var.

### 8a. v0.9.0 release

- [ ] PR + squash-merge + signed tag + release artifacts.

---

## 9. v1.0.0 — Commercial-ready foundation

**Theme**: "First paying design partner."
**Ship gate**: real invoice sent + paid; CFO dashboard shows revenue; multi-tenant auth works; design partner has used 1 week without issues.
**Effort remaining**: ~40h.

- [ ] **Stripe integration** (~12h). Payment intent creation; webhook handling for payment events; subscription management.
- [ ] **Invoice generation** (~8h). Monthly invoice PDF generation; emailed to org admin; line items match billing records.
- [ ] **Per-org pricing tiers** (~5h). Starter / Growth / Enterprise. Config-driven; tier upgrades via Stripe.
- [ ] **Multi-tenant auth + RBAC** (~10h). Org-level + developer-level + api-key auth. Middleware in proxy enforces tenant isolation. RLS-by-tenant on Supabase.
- [ ] **CFO dashboard real data** (~5h). Revenue, churn, MRR, token-savings-by-tier metrics.
- [ ] **First design partner onboarding** (manual).
- [ ] **First real invoice sent + paid**.

### 9a. v1.0.0 release

- [ ] PR + squash-merge + signed tag + release artifacts.
- [ ] **Public CHANGELOG.md** ready (decision: open the repo? Or stay private + curated invite?).
- [ ] Optional: public landing surface.

---

## 10. Cross-cutting + carry-forward

These thread through every version. Track separately.

### 10a. Carry-forward never-blocking items

- [ ] **vitest 2 → vitest 4 / istanbul migration** (~4-8h). Trigger: any vitest 4 feature genuinely needed OR another tooling-asymmetry surface. Until then, the v8+TS source-maps functions-coverage limitation is documented in `stratum/vitest.config.ts`.
- [ ] **PB-21 justification cleanup** — re-state the real reason (cosign can't re-sign until PB-13 refreshes; verify-blob refactor would also fail) when PB-13 closes.
- [ ] **Cloudflare Worker deployment path** — defer to v1.0.x decision: hosted SaaS vs self-host-only. Code is already Worker-compatible per Stratum spec (`stratum/src/proxy/worker.ts` stub exists).
- [ ] **Conversation export/import format** — v0.8.x polish: clean way to share a debugged session with a friend.
- [ ] **Karpathy-pattern wiki support** (`/understand-knowledge` slash command from Understand-Anything pattern) — defer to post-v1.0.0 unless a real use case surfaces.

### 10b. Per-version recurring tasks (do these every version)

- [ ] Threat model entry added/updated for any new attack surface.
- [ ] ADR written for any load-bearing decision.
- [ ] LAUNCH_READINESS.md math refreshed.
- [ ] CHANGELOG.md updated (Keep-a-Changelog format).
- [ ] GitHub Release with release notes.
- [ ] PERSONAL_USE.md updated where workflow changed.
- [ ] Coverage thresholds verified.
- [ ] Eval suite re-run (Phase 2+).
- [ ] Skill manifest re-signed if any SKILL.md changed.
- [ ] Validator state re-confirmed (target 94/94 or 93/94 with PB-21 exception).

---

## 11. Status footer + envelope math

Update after every version ships. Snapshot at last update:

| Version | Status | Hours done (cumulative) | Hours remaining | Acceptance gate |
|---|---|---:|---:|---|
| v0.2.0 (foundation + Stratum subtree) | **SHIPPED** | ~155h | — | Sealed `aca4982` |
| v0.3.x (Phase 0 + Phase 1 + first-party Anthropic integrations + red/green TDD explicit) | NOT STARTED | 0 | ~115h | Friend can clone + setup + see live dashboard; `/security-review` GitHub Action gates PRs |
| v0.4.x (Phase 2 pruner + subagent-driven-development autonomous loops) | NOT STARTED | 0 | ~135h | Eval GREEN; zero Tier C regressions; 1 week no degradation; pilot autonomous loop succeeds on one Phase 2 sub-task |
| v0.5.x (Phase 3 memory + knowledge-graph view) | NOT STARTED | 0 | ~130h | Fact-survives-50-turn; tier latencies met; `/understand-codebase` works on this repo |
| v0.6.x (Phase 5 audit) | NOT STARTED | 0 | ~60h | CONFLICT in <5s; Opus <1% escalation |
| v0.7.x (Phase 4 TEE + Claude Code Security reasoning-based release gate) | NOT STARTED | 0 | ~84h | Modified-PCR rejected; <15ms latency; security reviewer signoff; Claude Code Security clean release |
| v0.8.x (polish + operator-ready) | NOT STARTED | 0 | ~50h | <5min cold-clone-to-running; backup tested |
| v0.9.x (billing schema) | NOT STARTED | 0 | ~30h | Postgres trigger blocks UPDATE; GDPR <30s |
| v1.0.0 (commercial-ready) | NOT STARTED | 0 | ~40h | First real invoice paid |
| **TOTAL to v1.0.0** | — | **~155h done** | **~644h remaining** | — |

**Session-14 envelope adjustments** (vs Session-13-closure baseline of ~570h remaining):
- v0.3.x: +25h reconciliation (Phase 1 sub-totals more honest at ~83h vs original ~80h estimate; +Anthropic integrations 3.5h; +red/green TDD doc 1h)
- v0.4.x: +15h subagent-driven-development autonomous loops
- v0.5.x: +30h knowledge-graph view
- v0.7.x: +4h Claude Code Security release-gate integration
- Total: ~+74h vs Session-13-closure (~570h → ~644h)

All additions are version-bounded — no scope-creep into other milestones. Math methodology unchanged from prior sessions.

That's ~15-19 months part-time on evenings/weekends. Best-of-best at every milestone. **No half-built features carried across versions.**

---

## 12. External integrations registry (per blueprint §10)

Living list of every third-party integration. Each entry: source repo + version pin policy + ADR reference + which version it ships in.

| Integration | Source | Version pin policy | ADR | Ships in |
|---|---|---|---|---|
| `anthropics/claude-code-security-review` GitHub Action | Anthropic (first-party) | SHA-pin per AST08; update via Dependabot PRs | TBD `governance/decisions/ADR-014-claude-security-review-integration.md` | v0.3.x |
| Claude Code `/code-review` slash command | Anthropic (first-party, built into Claude Code) | N/A (built-in) | TBD `governance/decisions/ADR-015-claude-code-review-in-pr-flow.md` | v0.3.x |
| Claude Code Security (reasoning-based, Feb 2026 GA) | Anthropic (first-party) | N/A (built-in) | TBD `governance/decisions/ADR-016-claude-code-security-release-gate.md` | v0.7.x |
| Subagent-driven-development pattern (idea borrowed; we keep our impl) | [obra/superpowers](https://github.com/obra/superpowers) (MIT) | Pattern only; no upstream dependency | TBD `governance/decisions/ADR-017-subagent-driven-development.md` | v0.4.x |
| Knowledge-graph view (idea borrowed; we keep our impl) | [Lum1104/Understand-Anything](https://github.com/Lum1104/Understand-Anything) (MIT) | Pattern only; no upstream dependency | TBD `governance/decisions/ADR-018-knowledge-graph-view.md` | v0.5.x |
| Anthropic SDK (`@anthropic-ai/sdk`) | Anthropic (first-party) | Caret on minor; verify per release | already present | v0.3.x bumps from `^0.39.0` to current |

---

## 13. Ideas → Artifacts workflow (per blueprint §11)

The iteration loop for adding new ideas to the roadmap. Documented here as the operational protocol.

When you bring a new idea (URL, feature request, repo to borrow from, market signal):

1. **You drop the idea** with minimal context. URL + one-line "what about this" is enough.
2. **I research**: `gh repo view` for GitHub URLs; WebSearch for features/announcements; read READMEs + key files; understand purpose, license, architecture.
3. **I synthesize**: explicit borrow/don't-borrow reasoning. What are the patterns worth taking? What stays out of scope? Why?
4. **I propose changes**: blueprint.md §10 (external integrations) + §11 (workflow doc) get the strategic update; plan.md gets the per-version checklist additions with explicit effort estimates and version assignments.
5. **I update the envelope**: total-hours-remaining moves; this is surfaced verbatim ("+30h folded into v0.5.x", "+4h v0.3.x", etc.). No silent scope creep.
6. **I add ADR placeholders** in `governance/decisions/` and link them in the integrations registry above.
7. **You review + iterate**: push back on anything; new ideas spawn another loop.

**Discipline rules**:

- Anthropic first-party tools: **integrate**, don't replace. Wire them into our existing PR-flow + release-gate.
- Prior-art repos: borrow patterns, not code (license + maintenance reasons). Cite source in blueprint + ADR.
- Every borrowed idea ships in a SPECIFIC version. No "we'll get to it eventually."
- Adding scope → effort estimate is mandatory. Envelope math gets updated in §11 status footer.
- If a new idea would push v1.0.0 beyond 24 months part-time, surface the timeline impact and ask whether to defer the idea OR push back something else.

**This section is the source-of-truth for the iteration protocol. Future "I have an idea" exchanges follow this loop.**

---

## 14. The standing rule (worth restating)

Best-of-the-best at every layer, every version, every PR. The "personal use" framing means: **no Stripe billing yet**. Nothing else. Every decision — every test, every signed skill, every redacted PII pattern, every Pinecone index, every Nitro Enclave PCR — is built as if a paying customer will run it tomorrow. Because eventually one will.
