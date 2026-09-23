# Research record — environment resilience for the sprint pipeline (2026-09-15)

Desk research performed by a Sonnet 5 research subagent on 2026-09-15 for
`specs/graph/R-resilience.md` (graph cycle 7). Sources are primary where
available; where a claim could only be confirmed through a secondary
summary, that is said. No repository files were modified by the research.

## 1. Preflight / "doctor" checks

- Homebrew, *Troubleshooting* — https://docs.brew.sh/Troubleshooting — `brew doctor` "checks the local package manager installation for conditions that can interfere with installs, upgrades, taps, and casks"; exits non-zero on any warning so CI can gate on it; checks include stale Xcode Command Line Tools.
- Flutter, `flutter doctor` (secondary summary, 2026) — https://flutterfever.com/flutter-doctor-command/ — per-line ✓/✗/! status per toolchain component with a final summary; designed to run in CI before builds.
- Bazel, *Hermeticity* — https://bazel.build/basics/hermeticity — "a hermetic build system always returns the same output by isolating the build from changes to the host system"; tools are versioned inputs rather than whatever is on `$PATH`.
- Kubernetes, *Liveness, Readiness, and Startup Probes* — https://kubernetes.io/docs/concepts/workloads/pods/probes/ — the three-way split maps onto "retry until ready" versus "escalate, don't restart forever".
- Temporal, *Monitor worker health* — https://docs.temporal.io/production-deployment/cloud/worker-health — 60 s heartbeats let the server tell "a Worker that is down" from one "processing tasks for a long time".
- Turborepo issue #3310 (open since 2023) — https://github.com/vercel/turborepo/issues/3310 — a `turbo doctor` request still unshipped; doctor commands are recognised practice but routinely deprioritised.
- Dagger issue #7733 — https://github.com/dagger/dagger/issues/7733 — open request for an engine health check.

**Recommendation adopted**: a doctor step before the backlog is touched, verifying `git` actually runs (not just resolves), state directories are writable, and no stale run is blocking; dual output (JSON at a fixed path plus a human table); never auto-run a licence, credential or sudo action.

## 2. Fault classification

- Google Testing Blog, *Flaky Tests at Google and How We Mitigate Them* (2016-05-27) — https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html — reruns apply only to tests explicitly marked flaky: classification precedes any retry policy.
- DORA — https://dora.dev/guides/dora-metrics/ and https://cloud.google.com/blog/products/devops-sre/using-the-four-keys-to-measure-your-devops-performance — the 2023 rename of MTTR to "failed deployment recovery time" counts only impairments caused by a change, not unrelated outages (confirmed via secondary summaries; the exact primary sentence was not retrieved).
- Buildkite, *Retry* — https://buildkite.com/docs/pipelines/configure/retry — exit status `-1` ("communication with the agent has been lost") carries its own retry rule, distinct from command exits 1–255.
- Microsoft Azure Architecture Center, *Retry* and *Circuit Breaker* — https://learn.microsoft.com/en-us/azure/architecture/patterns/retry and https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker — retry for faults that "typically correct themselves after a short period"; the breaker stops "retrying operations that aren't transient".
- Anthropic, *Building Effective Agents* (2024-12-19) — https://www.anthropic.com/engineering/building-effective-agents — "letting the agent know when a tool is failing and letting it adapt works surprisingly well", backed by "deterministic safeguards like retry logic and regular checkpoints" and explicit stopping conditions.
- CrewAI issues #5802 and #7460 (open) — https://github.com/crewAIInc/crewAI/issues/5802, https://github.com/crewAIInc/crewAI/issues/7460 — no idempotency guard on tool retries and no built-in backoff in a widely used framework: framework-level retry is not safe by default.

**Recommendation adopted**: three buckets — environment/infra (halt and checkpoint, never retry blindly), transient (bounded retry), code (signal, not fault; never auto-retried) — with deterministic signatures classifying first and agent judgment only for residual cases, recorded as such.

## 3. Durable execution and checkpoint/resume

- Temporal, *Workflow Execution* — https://docs.temporal.io/workflow-execution — replay "picks up where the last recorded event occurred in the Event History"; non-deterministic work lives in Activities whose results are recorded.
- LangGraph, *Durable execution* and *Persistence* — https://docs.langchain.com/oss/python/langgraph/durable-execution, https://docs.langchain.com/oss/python/langgraph/persistence — checkpoints per superstep with monotonically increasing ids; resume by re-invoking with the same `thread_id`; the in-memory saver "does not persist between restarts".
- Inngest, *Steps* — https://www.inngest.com/docs/learn/inngest-steps — "each step's result is saved after it succeeds, and on retry, completed steps are skipped and their cached results are replayed"; event-derived idempotency keys.
- Prefect, *Retries* — https://docs.prefect.io/v3/how-to-guides/workflows/retries — flow-level retry re-executes all tasks from scratch; only task-level retry resumes: "checkpoint/resume" claims are not equivalent across tools.
- Anthropic, *How we built our multi-agent research system* (2025-06-13) — https://www.anthropic.com/engineering/multi-agent-research-system — "restarts are expensive and frustrating", so the system resumes "from where the agent was when the errors occurred" and externalises critical state.

**Recommendation adopted**: `.workflow/state/` as the event history — a per-run record with the exact launch inputs, per-task journaled outputs, and an idempotency key per side-effecting action; resume reads the record and never re-plans; nothing that matters for resume lives only in memory.

## 4. Rate limits, quota and outages

- Anthropic, *Claude API errors* (fetched 2026-09-15) — https://platform.claude.com/docs/en/api/errors — `429 rate_limit_error` includes tier spend caps and Claude Code workspace spend limits; "a tier spend-cap 429 has no `retry-after` header and keeps failing until access resumes"; `529 overloaded_error` is temporary and unrelated to the caller's usage; `500 api_error`: retry with exponential backoff; SDKs retry transient failures twice by default honouring `retry-after`; prefer streaming or the Batches API for long requests.
- AWS Architecture Blog, Marc Brooker, *Exponential Backoff And Jitter* (2015-03-04) — https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ — full jitter (`sleep = random(0, min(cap, base * 2^attempt))`) minimises aggregate work; un-jittered backoff synchronises retries into clusters.
- Microsoft *Retry* / *Circuit Breaker* — as in §2.

**Recommendation adopted**: quota and session-limit states are "paused", visibly different from "failed", and are never retried in a loop; transient API states get bounded, jittered retries (owned by the SDK here) with a cap on total wait before escalating to halt.

## 5. Test-suite hermeticity

- Bazel, *Hermeticity* — https://bazel.build/basics/hermeticity — declared inputs and per-action sandboxing; a `git rev-parse` shell-out is an undeclared dependency on host PATH, git config and licensing state.
- Node.js ESM — https://nodejs.org/api/esm.html — `import.meta.dirname` / `import.meta.filename` (added in v20.11.0) give a module its own path with no subprocess; this checkout runs Node 26.

**Recommendation adopted**: derive the repo root from `import.meta.dirname` or a `package.json` walk-up; a static grep/lint gate against `child_process` calls to toolchain binaries in test files; no `try/catch` fallback to `process.cwd()`.

## 6. Kill switch and halt semantics

- OWASP, *Agentic Security Initiative* / *Top 10 for Agentic Applications 2026* — https://genai.owasp.org/initiatives/agentic-security-initiative/ — "insufficient supervision or lack of kill switches" is a listed contributing factor; the mitigation is kill switches plus continuous monitoring (confirmed via secondary summaries dated 2025-12-09).
- Practitioner write-ups (Straiker, opsagent.pl, AuthorityGate; secondary) — a pause "halts new tasks; it doesn't undo the last five actions": halt is not rollback.
- Rob Ewaschuk, *My Philosophy on Alerting* — https://docs.google.com/document/d/199PqyG3UsyXlwieHaqbGiWVa8eMWi8zzAn0YfcApr8Q — "every page should be actionable".
- Thomas Strömberg, *The Anatomy of a Great Playbook Entry* (2021-05-21) — https://dev.to/tstromberg/the-anatomy-of-a-great-playbook-entry-35od — severity, impact, metrics, background, mitigation checklist, debugging, references; written for the person hitting the problem cold.

**Recommendation adopted**: keep the `graph-halt` file as the primitive but always pair a halt with a structured, human-first blocked record that embeds the exact fix command and the exact resume command; an agent never clears its own halt.

## Ranked requirements (as delivered by the research, before spec editing)

1. Structured blocked record with the resume command embedded.
2. File-based durable journal keyed by run id and completed-task idempotency keys.
3. Preflight doctor at pipeline start verifying git actually runs, auth works, state dirs writable.
4. Fault classification before any retry/halt decision.
5. Non-retryable quota states handled separately from transient states.
6. Jittered, bounded backoff honouring `retry-after` for transient faults only.
7. Repo root from `import.meta.dirname` instead of a `git` subprocess.
8. Lint/CI gate against toolchain shell-outs in tests.
9. Halt files cleared only by a human.
10. Idempotency keys on side-effecting actions.
11. Heartbeat / last-progress timestamps to tell slow from dead.
12. Streaming or batch API preference for long turns.
13. Circuit breaker on the model client.
14. Per-task machine-readable classification in the journal.
15. Doctor output in both JSON and human form at a fixed path.
