# DevOPs + Stratum — Masterpiece Execution Plan

**Owner**: Milton Adina
**Authored**: 2026-05-28 (paired with `blueprint.md`)
**Quality bar**: **Best-of-the-best at every layer.** No exceptions. The "personal use" framing means no Stripe billing yet — it does NOT relax quality, coverage, security, or rigor.
**Format**: GitHub-style `- [ ]` checklist. Group order = recommended execution order.
**Distribution model**: public repo today (owner decision 2026-09-23) → friends-install tomorrow (v0.4.x+) → commercial v1.0.0+. Every line is built for the friend-install + commercial-future case.

**Status snapshot (2026-09-23)**:
- v0.3.0 is tagged at `250f90a` and published after release preparation PR #30,
  Stratum dependency remediation PR #31, and final changelog PR #32.
- Area R proof corpus reached 152/152 valid before the merge. The public
  repository decision's revised claim passed its focused rerun; the full
  release PR claim gate remains to run.
- PB-16 signing key is registered and locally proved with a temporary signed
  tag. Release-sign branch dispatch run `35881270832` signed all 17 universal
  skills; tag-triggered verification run `35883804367` passed.

---

## 0. Standing rules (apply to every checkbox below)

- **PR-flow per PB-17 Option β** for every change to `main`. Squash-merge via `gh pr merge --squash --delete-branch`. No direct commits. (Long-lived working branches like `stratum-phase-0-capture` stay open and PR at full phase acceptance.)
- **Claim-validator stays at 94/94 (or 93/94 max with PB-21-coupled-to-PB-13 documented exception).** Any new claim must run cleanly.
- **Coverage thresholds binding**: statements ≥85%, branches ≥80%, functions ≥90%, lines ≥85% on production code paths.
- **Every shipped skill Sigstore-signed.** `release-sign.yml` must run cleanly (depends on PB-13 closure).
- **Every release git-tag cryptographically signed.** This repository uses the
  owner's registered SSH signing key for Git tags.
- **AP-5 surfacing**: Proof Theater, Reflexive Patch, Scheduler-Failure are honest-stop conditions. Surface immediately, don't paper over.
- **Read-all-first-then-Write** before edit batches.
- **JS regex no PCRE.** `[\s\S]` for multiline.
- **Per stratum CLAUDE.md**: TypeScript strict, no `any`, JSDoc on exports, no `.unwrap()` in Rust production paths.
- **EARS specs before non-trivial code.** Spec → claim → implementation → claim → proof.
- **Launch readiness is ALWAYS derived from markdown source-of-truth.** When the user asks for "status", "launch readiness", "where are we", "give me a report" — the response is produced by reading `blueprint.md` + `plan.md` + `docs/LAUNCH_READINESS.md` and assembling the canonical table set defined in `blueprint.md §11`. **Never fabricate figures, version-progress numbers, validator counts, or polish-backlog states.** If a number isn't in the .md sources, surface that gap explicitly ("not yet recorded in LR; need to refresh"). The slash command `/launch-readiness` produces the canonical output (see `slash-commands/universal/launch-readiness.md`). Refresh `docs/LAUNCH_READINESS.md` at: (a) every version ship, (b) every PR merge that adds/changes plan.md tasks or effort estimates, (c) every Ideas → Artifacts iteration that adjusts the envelope.

---

## 1. v0.2.x → v0.3.x prerequisites (closes carry-forward; user-side actions)

These unblock the trust-chain story. Do these BEFORE starting Phase 0 corpus capture.

### 1a. PB-13 closure (GitHub Actions billing — user-side)

- [ ] **User-side**: Navigate to https://github.com/settings/billing/spending_limit. Set a non-zero spending limit on that specific page.
- [ ] **User-side**: Confirm in chat the exact value set (e.g., "spending-limit set at github.com/settings/billing/spending_limit to $10").
- [ ] **Agent (dedicated session)**: dispatch `release-sign.yml --ref v0.2.0`. Monitor run. If `conclusion=success` AND `steps>0` AND duration >10s → cosign verify-blob → close PB-13 + PB-21 (PB-21 closes-with-PB-13). If failure → AP-5 Scheduler-Failure pattern check, surface honestly, do not retry without new signal.

### 1b. PB-16 closure (git tag signing — user-side)

- [x] **User-side**: create a passphrase-protected Ed25519 SSH signing key and register its public half on GitHub. Fingerprint `SHA256:sYw5s4aqGAQ9TqFdgI6oCX8K8F978kICyJhTMHArGJQ` was verified locally and the GitHub signing-key entry was confirmed.
- [x] **Agent**: configure this repo for SSH tag signing, create and verify the temporary `v0.2.1-test` tag, delete it, and document the flow in `PERSONAL_USE.md`. `git tag -v` reported a good signature.

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

- [x] **PR `stratum-phase-0-capture` → `main`** (~1h). Squash-merged as PR #25 at `18d7135`; linear history maintained.
- [x] **Cut v0.3.0 tag** with the registered SSH signing key. `git tag -v`
  verified the signature; tag points to `250f90a`.
- [x] **release-sign.yml branch dispatch** signed 17 cosign artifacts in run
  `35881270832`; tag-triggered verification passed in run `35883804367`.
- [x] **Update LAUNCH_READINESS.md** with the v0.3.0 release-gate math and
  the remaining v1.0.0 gates. The historical effort-hours percentage remains
  labeled as historical until recalculated from current scope.
- [x] **GitHub Release** with release notes (Keep-a-Changelog format),
  published at `https://github.com/MILTONADINA/DevOPs/releases/tag/v0.3.0`.
- [x] **CHANGELOG.md update** at repo root for v0.3.0.

---

## 3. v0.4.x — Phase 2 KadaneDial Pruner

**Theme**: "My Claude Code costs went down 30-50% without quality loss."
**Ship gate**: Eval suite GREEN; zero Tier C regressions; 1 week real-use confirms no degradation.
**Effort remaining**: ~120h.
**Current evidence:** The default per-hour decay failed a one-question real
local Qwen LoCoMo run by dropping all gold evidence; a predeclared span-based
setting retained it while pruning 22% of turns. This is an exploratory
single-question comparison, not a release gate. A one-question local
LongMemEval haystack timed out before scoring. Full judged coverage, Tier C,
and real-use gates remain open; the runners now fail nonzero without a provider.

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
- [x] **Tier C golden queries**. A 50-case synthetic developer-workload
  corpus with required and forbidden anchors runs through the real cached
  encoder and pruner without a judge. Caller-supplied project scope metadata excludes
  foreign turns before scoring; all 10 authored project-scope cases now pass,
  while the current default is still RED at 29/50 because dormant and
  multi-fact evidence is lost and stale alternatives survive. The fixture's
  original text, ages, and golden anchors are unchanged. Commercial requests
  now derive a trusted project scope from a bound API key. Memory sessions and
  structured facts persist it, and the fact, conflict, audit-status,
  explicit-session, and graph APIs filter reads by authenticated scope.
  Historical graph rows with uncertain project identity are omitted from
  commercial reads. Other org-wide APIs may still need project review. The pruner is still out of
  the request path and unbound keys supply no project scope. Zero
  Tier-C failures remains a v0.4 ship gate.
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

Borrowed from [obra/superpowers](https://github.com/obra/superpowers). Extends our existing subagents (`subagents/universal/{planner,coder,reviewer,tester,security,validator}.md` — `researcher` removed 2026-09-14 as redundant with the native Explore agent) with explicit autonomous-loop semantics. Folded into v0.4.x because Phase 2 pruner work is the right vehicle to prove the loop (it's complex, multi-stage, eval-gated — exactly the workflow that benefits from autonomous subagents).

- [ ] **Subagent autonomous-loop pattern doc** (~3h). New file `subagents/AUTONOMOUS_LOOP.md`: spec → plan → assign tasks → subagent works → inspect → review → continue → eval-gate. Adapt superpowers' rhythm to our claim-validator discipline (every subagent-completed unit emits a claim with a proof script).
- [ ] **Extend `planner.md` subagent** (~2h) to produce implementation plans "clear enough for an enthusiastic junior engineer with poor taste, no judgment, no project context, and an aversion to testing to follow" (verbatim superpowers framing — apt for our quality bar).
- [ ] **Extend `coder.md` subagent** (~2h) to enforce TDD red/green + YAGNI + DRY explicitly. Surface tests-first as a hard constraint.
- [ ] **Extend `reviewer.md` subagent** (~3h) to inspect each completed unit before signoff. Hooks into our existing claim-validator + Anthropic `/code-review`.
- [ ] **Add `orchestrator.md` subagent** (~3h) to manage the autonomous loop. Owns the spec → plan → assign → inspect cycle. Bounded by token budget (cost-controls/budget.yml) and time budget per cycle.
- [ ] **Pilot the autonomous loop** on one Phase 2 sub-task (eval harness scenario authoring is a good fit — repetitive, structured) (~2h pilot + retrospective). Document outcomes + lessons in baton.md.

---

## 4. v0.5.x — Phase 3 Three-Tier Memory (Hot / Warm / Cold)

**Theme**: "Stratum remembers what we decided. I never re-explain decisions."
**Ship gate**: fact-survives-50-turn-gap test passes; Tier 2 <50ms p95;
Tier 3 graph/vector latency is measured on the approved Supabase implementation;
Zod gates all writes; the DevOPs session-start hook retrieves relevant facts.
**Status (2026-09-23)**: hot, warm, Supabase graph/vector, promotion code,
memory API, read-only `understand-codebase` CLI, and a scoped Claude
SessionStart recall bridge exist. The simulated 50-turn survival test passes.
Live session-start binding/retrieval and the Tier-2 latency gate remain open.
The paid Supabase project is retired; ADR-0020 selects the free local Compose
stack for development, not production release readiness.
ADR-0013 replaces Pinecone/Neo4j as v0.5 ship dependencies while keeping
their adapter interfaces available. The original ~100h estimate is stale and
must be recalculated after the open gates are reconciled.

### 4a. Tier 1 — Hot Memory (rolling window)

- [x] **`stratum/src/memory/hot/tier1.ts`**. In-memory rolling window per
  active session, default two-hour window, with eviction into Tier 2.
- [x] **Tier 1 query API** + tests (`recent()` and `test/memory/memory.test.ts`).

### 4b. Tier 2 — Warm Memory (Supabase facts + Llama extractor)

- [x] **Five fact-type Zod schemas** in `stratum/src/types/facts.ts` and
  `stratum/src/memory/warm/schemas.ts`; invalid facts are rejected before write.
- [x] **Supabase migration** for five typed fact tables in
  `stratum/supabase/migrations/20260406000000_initial_schema.sql`. ADR-0012
  chose typed tables in place of the older single `facts` table plan.
- [x] **`stratum/src/memory/warm/extractor.ts`**. Structured extraction over
  an injected model completion; validated facts only. The live smoke used Haiku.
- [x] **`stratum/src/memory/warm/tier2.ts`** + query API. Trusted org/session
  keys and read validation are covered by unit and live smoke evidence.
- [ ] **Tier 2 latency gate**. `npm run bench:tiers` exists, but the recorded
  remote-client result exceeded its 80ms monitoring target; the blueprint's
  <50ms p95 ship target needs a representative deployment measurement.

### 4c. Tier 3 — Cold Memory (Supabase pgvector + graph)

- [x] **Tier 3 vector store**. `stratum/src/memory/cold/vectors.ts` uses
  Supabase pgvector with content-free embeddings and typed source pointers;
  ADR-0013 retains a `VectorStore` seam for a future Pinecone adapter.
- [x] **Tier 3 knowledge graph**. `stratum/src/memory/cold/graph.ts` uses
  Supabase entity/edge tables and a supersession query; ADR-0013 retains a
  `KnowledgeGraph` seam for a future Neo4j adapter.
- [x] **Tier 3 latency measurement**. `npm run bench:tiers` measured the
  Supabase graph/vector paths within its recorded 200ms p95 monitoring target.
  Recheck against a binding release target after deployment topology is chosen.

### 4d. Promotion + integration

- [ ] **Nightly Tier 2 → Tier 3 promotion job**. The idempotent
  `npm run promote` script exists; a scheduled operator invocation is still
  required before calling nightly promotion complete. The local Compose
  round-trip verifies active-fact graph/vector promotion, suppressed-fact
  exclusion, and a bound graph query; it does not establish nightly operation.
- [x] **Claude SessionStart recall bridge**. The scoped, bounded bridge reads
  current-project Tier 2 facts and local semantic matches. The operator's
  `DEVOPS_STRATUM_PROJECT_SCOPE` filters both before limits; without it the
  bridge selects only legacy unbound facts. A disposable local database check
  covers two projects in one organization. See
  `stratum/scripts/session-start-context.ts` and PR #42.
- [ ] **Live session-start binding and recall**. Configure a trusted project/org
  mapping and local database credentials, then measure retrieval/injection in
  a real Claude session. Other tools' session-start adapters remain open.
- [x] **50-turn survival test**: `stratum/test/memory/manager.test.ts` proves a
  decision evicted from hot memory is extracted, persisted, and recalled after
  50 unrelated turns using a fake model and database. A separate live memory
  pipeline smoke was recorded; it does not establish a live 50-turn result.

### 4e. v0.5.0 release

- [ ] PR + squash-merge.
- [ ] Signed tag.
- [ ] LAUNCH_READINESS + CHANGELOG.
- [ ] GitHub Release with memory architecture diagram.
- [ ] Update PERSONAL_USE.md + ARCHITECTURE.md with memory subsystem.

### 4f. Borrowed pattern integration — knowledge-graph view (NEW, ~30h)

Borrowed from [Lum1104/Understand-Anything](https://github.com/Lum1104/Understand-Anything). Layers visualization and exploration on the approved local Tier-3 graph/vector stores. `stratum/scripts/understand-codebase.ts` provides a read-only entity/semantic-query CLI with a universal bound slash adapter. Project-local JS/TS/Rust/Python File and Function ingestion, fuzzy and semantic node search, paged dependency tours, exact-path durable Tier-2 links, selectable in-canvas fact nodes, and a real-Chrome dashboard check are implemented. The opt-in source-summary adapter now requests non-thinking output; a real local Qwen sample produced accepted summaries for 11 Files, and a disposable Compose run persisted two File summaries with four embeddings. Representative quality across arbitrary source remains open.

- [ ] **Knowledge-graph extraction pipeline**. Project-local JS/TS/Rust/Python ingestion walks files, extracts top-level functions and local imports/modules, and writes File/Function nodes with DECLARES/DEPENDS_ON edges. A dedicated edge table durably links indexed Files to active, exact-path Tier-2 changes and decisions; the canvas shows those links when a File is selected. An opt-in loopback model summarizes File nodes before offline embedding; real local Qwen passed an 11-File sample and disposable persistence check. Representative source coverage and quality remain open.
- [x] **`/understand-codebase` slash command**. The universal command invokes the read-only CLI through a trusted project/org adapter; the graph dashboard is available separately.
- [ ] **Dashboard `/dashboard/graph` view** (~10h). A vanilla JS route offers pan, zoom, click-to-expand, fuzzy search, a paged File/dependency tour, and selectable fact nodes over durable exact-path links. The sidebar shows paths, File summaries, relationships, and active Tier-2 facts. Real Chrome verified generated summaries from the local Qwen ingestor in the scoped sidebar and dependency-order tour while excluding a foreign File. Representative graph/source coverage remains open.
- [x] **Fuzzy + semantic search across the graph** (~4h). The dashboard searches node names or offline-indexed File/Function embeddings across the full organization graph, including nodes outside its 500-node snapshot, with immediate neighbors. The local database fixture verifies organization scope and stale-pointer filtering.
- [x] **Auto-generated guided tours** (~3h). The dashboard traverses all File/dependency pages, orders dependencies first with cycle handling, and shows bounded prose explaining each File's summary and direct dependency direction. Previous/Next navigation and literal text rendering are verified in Chrome; a disposable real-Qwen/Compose run verified persisted summaries in dependency order.
- [ ] **(Future, defer)** Karpathy-pattern wiki support (`/understand-knowledge`). Useful when memory matures. Tracked but not in v0.5.x scope.

---

## 5. v0.6.x — Phase 5 Git-Attestation Audit Engine

**Theme**: "Stratum's memory is trustworthy because it's cross-checked against Git history."
**Ship gate**: contradicting fact → CONFLICT in <5s; Opus escalation <1% of facts in 1000-fact test; Llama spot-check confidence-flagging works.
**Effort remaining**: not recalculated after the build-ahead audit modules and
dashboard landed; the historical ~60h estimate is stale.

### 5a. Git indexer + attestation checker

- [x] **`stratum/src/audit/git-indexer.ts`**. Indexes recent Git history into
  structured code changes. `npm run bench:audit-indexer` measures five real
  100-commit samples against the <5s p95 local target; deployed representative
  performance remains a v0.6 release check.
- [x] **Deterministic Git attestation core**. `stratum/src/audit/git-attestation.ts` compares typed code facts against indexed changes and returns CONFIRMED / CONFLICT / UNVERIFIED; `audit-engine.ts` persists the outcomes. It is currently called by `npm run audit:repo`, not the proxy request path. Explicit binding to a fact's claimed `commit_hash` remains open.
- [x] **Core attestation tests**. `stratum/test/audit/git-attestation.test.ts` covers confirming, contradicting, unverified changes, and exact claimed-commit confirmation. Absence of a confirming indexed change returns UNVERIFIED.
- [x] **Claimed commit anchor**. A fact's `commit_hash` must match its confirming indexed change; missing or mismatched anchors return UNVERIFIED. A rename's delete/add evidence must share one commit. See `specs/audit/commit-anchor.md`.

### 5b. Llama spot-check + Opus escalation

- [x] **Llama spot-check core**. `stratum/src/audit/llama-check.ts` supplies deterministic ~10% sampling, a bounded untrusted-data prompt, verdict parsing, and a confidence score through an injected completion seam. A real Llama provider and request-path invocation remain open.
- [x] **Opus escalation core**. `stratum/src/audit/opus-escalation.ts` parses a deeper verdict through an injected completion seam; the spot-check result flags confidence <0.85 for escalation. The two stages are not yet orchestrated in the request path or verified against a real provider.
- [ ] **Live staged audit**. Invoke the sampled Llama check and conditional Opus escalation for the trusted organization with real providers; verify the 1000-fact rate and cost limits before activation.
- [ ] **Cost monitor**: log Opus audit costs; alert if >2% of usage. (~3h)

### 5c. audit_conflicts table + dashboard alerts

- [x] **Audit schema migrations**. `audit_conflicts` is in the initial schema; the September migrations add atomic conflict suppression and per-fact `audit_statuses`. All 16 migrations applied in the loopback-only local Compose stack; a rolled-back SQL audit write and scoped API read passed. A disposable real-Git `audit:repo --persist` run also verified local suppression, status, and alert. Deployed behavior remains unverified.
- [ ] **CONFLICT alert pipeline** (~4h). Deterministic audit writes conflicts
  to `audit_conflicts` idempotently. The dashboard now reads the protected,
  organization-scoped conflict API and refreshes every 3s while visible.
  A real local Chrome run rendered an injected scoped conflict in 2,991 ms
  through that API. This measured the browser path with an in-memory store;
  the <5s deployed insertion-to-render gate remains open.
- [x] **Dashboard read surfaces**. Historical Drift conflict panel and per-fact
  CONFIRMED/CONFLICT/UNVERIFIED badges use the scoped status API. Live
  insertion-to-render verification remains open.

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

- [ ] **`npm run setup`** (~15h). The root command detects macOS/Linux/WSL2, installs missing Stratum dependencies, starts project-local Supabase Compose, and smoke-tests the real proxy/database listener without `.env` access. A fresh Ubuntu 24.04 hosted runner installed 402 packages, applied 29 migrations, and passed the real loopback proxy/database smoke in 67 seconds (CI run `35949731799`). A project-local fresh macOS clone with no Stratum dependencies or database volume passed the same setup in 53 seconds using an isolated Compose instance; its teardown left the primary stack running. Docker images were cached on that Mac. Clean macOS and WSL2 laptops, provider-backed message traffic, and real-data recovery remain unverified.
- [ ] **PERSONAL_USE.md v2** — full polish (~5h). Daily workflow, env vars, troubleshooting common errors, FAQ.
- [x] **DEVELOPER_GUIDE.md** (~6h). Contributor checkout setup, current root/Stratum tests and lint/typecheck, PR review flow, and owner signing procedure are documented; clean-machine and real-data release gates remain open.
- [ ] **ARCHITECTURE.md** (~6h). System design overview. Diagrams. Component responsibilities. Data flow. Cross-reference to ADRs.

### 7b. Observability + ops

- [ ] **Sentry error tracking integration** (~4h). DSN configurable via env. PII-redaction wrap on error events. Free tier OK for personal use.
- [ ] **Grafana / Langfuse dashboards** (~6h). OTel → Grafana for proxy metrics; Langfuse for LLM observability. Dashboards exported as JSON in `observability/dashboards/`.
- [ ] **Performance benchmark suite** (~5h). Latency p50/p99 tracked per release. Regression detection on PR (>20% slower = fail).
- [ ] **Runbooks** (~5h). Incident response, backup/restore, common operational tasks. In `docs/runbooks/`.

### 7c. Data + config

- [ ] **Multi-environment config** (~4h). `config.dev.yml` / `config.prod.yml` overrides. Document in PERSONAL_USE.md.
- [ ] **Versioned schema + migration scripts** (~4h). `stratum/scripts/migrate-session-schema.ts` (already in Phase 0 spec). Test v0.1.0 → v0.2.0 round trip.
- [ ] **Backup + restore** (~5h). The local Compose check now backs up, deletes, and restores a disposable audited organization, including suppression, status, and alert evidence. Paged export prevents silent truncation under a REST row cap. The local operator runbook is in `docs/runbooks/LOCAL_STRATUM.md`. Clean-machine and real-data recovery remain open.
- [ ] **Telemetry policy + opt-out** (~3h). What does Stratum emit? Where? Where's `STRATUM_TELEMETRY_OPT_OUT=true`? Documented in PERSONAL_USE.md + new `TELEMETRY.md`.

### 7d. Distribution polish

- [ ] **Plugin marketplace metadata** (~2h). Verify `.claude-plugin/marketplace.json` is current.
- [ ] **License clarity** (~2h). MIT vs Apache vs custom. Decide. Update LICENSE + headers if needed.
- [x] **CONTRIBUTING.md polish** (~3h). The contributor checklist links to DEVELOPER_GUIDE.md and reflects current proof, CI, and conditional Claude review behavior.

### 7e. v0.8.0 release

- [ ] PR + squash-merge + signed tag + release artifacts + full docs landed.

---

## 8. v0.9.x — Phase 6 billing schema (no Stripe yet)

**Theme**: "Forward-compat for v1.0.x commercial."
**Ship gate**: cannot modify a billing record (Postgres trigger test passes); GDPR erasure <30s on 1-year data; schema ready for Stripe wiring.
**Effort remaining**: ~30h.

- [ ] **`stratum/src/billing/recorder.ts`** (~10h). HMAC-SHA256-signed `BillingRecord` writes. Append-only.
- [x] **Append-only Postgres trigger**. The applied local migration raises on
  UPDATE, UPSERT, DELETE, and TRUNCATE. A rolled-back PostgreSQL fixture
  verified those rejections, generated fee columns, and the billing-to-session
  foreign key. The signature verifier now requires explicit credentials,
  pages through the exact record count, and fails on partial reads; a capped
  1,001-record fixture found tampering after the first REST page. This does not
  close the separate erasure or release gates.
- [ ] **`stratum/src/billing/calculator.ts`** (~5h). Per-record + monthly aggregate calculations. `0.20 × (original - quarantined) × price` formula (placeholder; not active until Stripe).
- [ ] **`stratum/src/billing/invoice.ts` stub** (~3h). Interface only; no Stripe yet. Implementable when v1.0.x customer arrives.
- [ ] **Complete invoice read gate**. The invoice, CSV, and developer
  summary paths now page the exact scoped billing count; the CLI fails when
  explicit database credentials are absent. A capped 1,001-row fixture
  verifies full reads. Real partner invoice and payment remain open.
- [ ] **GDPR erasure endpoint** (~5h). The current immutable billing records
  have organization/session foreign keys, so in-place session-ID replacement
  is impossible. `specs/billing/session-erasure.md` and ADR-0021 now define the
  scoped inventory, shared-graph safety, financial retention decision, and
  one-year benchmark requirements. Establish the applicable legal basis and
  implement the boundary before an endpoint can report success. A read-only
  local database RPC now counts session-linked rows and distinguishes complete,
  shared, and uncertain graph provenance. Two-session promotion and local
  backup/restore checks preserve recorded graph and File-to-fact source links.
  Untagged graph rows, RAM,
  backup deletion, and external copies remain unresolved. No compliance claim
  is made yet.
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
| v0.5.x (Phase 3 memory + knowledge-graph view) | IN PROGRESS | not recalculated | not recalculated | 50-turn survival test; live session-start recall; tier latencies met; `/understand-codebase` works on this repo |
| v0.6.x (Phase 5 audit) | IN PROGRESS | not recalculated | not recalculated | CONFLICT in <5s; Opus <1% escalation; live request-path audit |
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
