# Graph / Area J — Jev judgments in the development pipeline

**Spec ID**: graph/J-jev-judgments
**Status**: approved (owner, 2026-09-25: "use jev heavily to accelerate development process")
**Last updated**: 2026-09-25
**Owner**: miltonadina

---

## Context

TypeSafe's Jev is a System One model: given a `state` and typed questions (Choice, Score, Noul), it returns typed answers with calibrated probabilities instead of generated text, at $0.042 per million input tokens and 1,200 requests per minute (docs.typesafe.ai/models, 2026-09-25). The development pipeline has several judgments that are narrow, repetitive, and currently made either by brittle string rules or by a full reasoning agent. Examples are classifying why a proof failed, classifying an environment fault that no deterministic signature matched, and checking whether cited evidence supports a claim. Jev can make those judgments fast and cheaply, with a confidence that code can gate on, and escalate only the uncertain remainder to an agent or a person.

## Constraints

- Code owns the workflow. Jev answers narrow questions, and code applies thresholds and policy. A Jev answer is never proof of work by itself. Principle 5's proof rule is unchanged.
- The API key comes from the `TYPESAFE_API_KEY` environment variable, or from the file named by `TYPESAFE_API_KEY_FILE` (plain text or RTF). Only that path may appear in machine-local settings (for Claude Code, the gitignored `.claude/settings.local.json`). No key is stored in the repository, in `.workflow/`, or in logs.
- Only repository text and this project's own logs are sent. Stratum customer or session data (`stratum/data/`), `.env` files, and anything secret-shaped are never sent.

## Out of scope

- Using Jev inside Stratum's request path or product features. That sends customer context to a third party and needs its own spec, a threat-model update, and an ADR.

## Functional requirements (EARS)

### REQ-J1 (Ubiquitous) — One zero-dependency client
THE SYSTEM SHALL provide `scripts/jev.mjs`, which uses only Node built-ins. It SHALL call `POST https://api.typesafe.ai/v1/systemone` with a bearer token resolved from `TYPESAFE_API_KEY`, or else from the file named by `TYPESAFE_API_KEY_FILE`, and return the response's `model`, `answers` and `usage` unchanged.

### REQ-J2 (Unwanted behaviour) — Fail closed without a key
IF neither `TYPESAFE_API_KEY` nor a readable `TYPESAFE_API_KEY_FILE` yields a key, THEN THE SYSTEM SHALL throw a `JevUnavailableError` before any network call, so every caller keeps its non-Jev path.

### REQ-J3 (Unwanted behaviour) — Never send secret-shaped content
IF the serialized `state` or `questions` contain a secret-shaped string (private-key header, AWS access key, GitHub token, Slack token, Stripe live or restricted key, Anthropic, OpenAI or TypeSafe API key, or a connection URI carrying a password), THEN THE SYSTEM SHALL throw a `JevSecretInStateError` naming the rule, before any network call.

### REQ-J4 (Event-driven) — Bounded retries on 429 and 529
WHEN the API answers 429 or 529, THE SYSTEM SHALL retry with jittered exponential backoff, honoring `retry-after` when present, for at most 4 attempts in total. It SHALL NOT retry 401 or 422, and SHALL throw a `JevHttpError` carrying the status and body.

### REQ-J5 (Ubiquitous) — Timeouts
THE SYSTEM SHALL abort a request that takes longer than its timeout (default 30 seconds) and count the abort as a retryable failure.

### REQ-J6 (Ubiquitous) — Confidence gating helpers
THE SYSTEM SHALL provide `decide(answer, {minConfidence, minNoul})`, which returns the answer's value only when its confidence, or for a Noul its distance from 0.5, clears the threshold, and otherwise returns `{uncertain: true}` so the caller escalates.

### REQ-J7 (Ubiquitous) — Allowlisted host
THE SYSTEM SHALL list `api.typesafe.ai` and `docs.typesafe.ai` in `.workflow/network-allowlist.txt`.

### REQ-J8 (Event-driven) — Proof-failure triage
WHEN `scripts/triage-claims.mjs` runs, THE SYSTEM SHALL re-run each failing claim's `test_command` with a timeout. It SHALL send Jev the claim's description, command, exit code and the last 60 lines of output with secret redaction, ask one Choice for the failure's cause, and write a table of claim, cause, probability, confidence and whether the case needs escalation to `.workflow/state/claim-triage-<date>.md`.

### REQ-J9 (Event-driven) — Residual fault classification
WHEN `scripts/graph-classify-fault.mjs` receives a failure that no deterministic signature matches and no `--agent-class` is given, THE SYSTEM SHALL ask Jev one Choice over the four REQ-R6 classes (`environment`, `api`, `transient`, `code`), sending only the first 20 error lines and the exit code. It SHALL return `classified_by: jev` with the confidence and probabilities only when `decide()` clears a 0.8 confidence threshold. IF Jev is unavailable, refuses the state as secret-shaped, or is below the threshold, THEN THE SYSTEM SHALL exit 2 and require an explicit agent verdict, as REQ-R6 did before this tier. Signatures and an explicit `--agent-class` SHALL take precedence, and Jev SHALL NOT be called for them. This amends REQ-R6 (specs/graph/R-resilience.md), which names the tier.

## Acceptance criteria

### AC-J1.1 (REQ-J1..J6)
**Given** `tests/jev/jev-client.test.mjs` with an injected fake `fetch` **When** `node --test tests/jev/` runs **Then** it proves the following, with no network access and every test seen red before the implementation existed:
- the request shape and bearer header;
- key resolution from the environment, a plain key file, and an RTF key file;
- the pass-through of answers;
- fail-closed without a key;
- refusal of each secret shape;
- retry on 429 and 529 honoring `retry-after`;
- no retry on 401 and 422;
- the attempt cap;
- the timeout;
- the `decide` thresholds.

### AC-J8.1 (REQ-J8)
**Given** a real key **When** the triage runs on the current failing set **Then** every failing claim appears exactly once in the table, and each row whose confidence is below the threshold is marked for escalation.

### AC-J9.1 (REQ-J9)
**Given** `tests/graph-resilience/classify-jev.test.mjs` with an injected Jev call **When** `npm test` runs **Then** it proves, with no network access and every test seen red before the implementation existed:
- a signature and an explicit agent verdict each win without calling Jev;
- a confident answer returns `classified_by: jev` with its confidence, over exactly the four REQ-R6 classes, with the exit code in the state;
- an uncertain answer, an unavailable Jev, and error output holding a secret shape each require an agent verdict, and the secret case makes no network call.
