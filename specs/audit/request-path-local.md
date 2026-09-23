# Local request-path Git audit

**Scope:** optional deterministic audit of facts extracted from authenticated
commercial `/v1/messages` requests. The repository is an operator-selected
project-local Git checkout; no hosted Git or paid model is required.

## REQ-1 — Trusted repository boundary

WHEN `CQ_AUDIT_REPO_ROOT` is configured with local memory extraction, THE
SYSTEM SHALL resolve it against the canonical project root supplied by the
local runner and reject a nonexistent path or any path whose real location is
outside that root. Message content SHALL NOT choose the repository or a commit
anchor. The extractor SHALL continue stripping model-generated `commit_hash`.

## REQ-2 — Audit before recall

WHEN the local extractor yields typed facts, THE SYSTEM SHALL index the trusted
repository, compute deterministic statuses, and persist facts initially
suppressed. It SHALL then persist statuses and conflict evidence through the
existing organization/session-bound database RPC. After that RPC succeeds,
THE SYSTEM SHALL release only non-conflicting facts for recall; conflicting
facts SHALL remain suppressed. A failed Git index or audit write SHALL NOT
expose unreviewed facts.

## REQ-3 — Response isolation

WHEN a background audit fails, THE SYSTEM SHALL log the failure and leave the
successful upstream response unchanged. Graceful shutdown SHALL still await
the audit task.

## Acceptance criteria

- **AC-1:** local integration uses a disposable real Git rename followed by a
  deletion, a loopback extraction model, and the actual authenticated message
  route. The resulting fact is suppressed with a `CONFLICT` status and one
  alert tied to its trusted organization and memory session.
- **AC-2:** repository paths outside the project or escaping it through a
  symlink are rejected before Git access.
- **AC-3:** a fact remains suppressed if status persistence fails; successful
  non-conflicting facts become visible only after their statuses are stored.
