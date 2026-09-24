# Typed operational references

**Scope:** durable, concrete project facts such as a runbook path, API route,
command, release tag, environment variable name, table name, deployment
branch, local address, or schedule value. These facts are not necessarily a
technical decision, policy update, function change, variable change, or Todo.
This adds a sixth typed warm-memory fact without changing the existing five.

## REQ-1 — Extract a grounded reference

WHEN an ordered exchange directly states an operational subject and its
concrete reference, THE EXTRACTOR SHALL be able to emit an
`OperationalReference` with nonempty `subject` and `reference` fields and a
validated confidence. The reference SHALL appear verbatim in the source turns
of that extraction call; a model-invented or normalized reference SHALL be
discarded before persistence. The model SHALL NOT supply organization,
session, exchange, verification, audit, or supersession fields. The extractor
SHALL keep the current decision and function-change rules from
`specs/memory/current-batch-decisions.md`.

## REQ-2 — Persist and recall under trusted scope

WHEN a validated operational reference is stored, THE SYSTEM SHALL bind it to
the trusted organization, session, project, and source exchange using the same
rules as other typed warm facts. The database SHALL enforce those boundaries;
the commercial fact API, recent and semantic SessionStart paths, indexed
lexical search, vector promotion, and source-reference resolution SHALL
include only active in-scope rows. No reference SHALL create a graph
supersession edge or a reviewed-decision link.

## REQ-3 — Preserve lifecycle coverage

WHEN an organization is backed up or restored, THE SYSTEM SHALL include its
operational references with original IDs, scope, timestamps, and exchange
provenance. Session erasure inventory and shadow fact-coverage counts SHALL
include this table; exclusive Function-change shadow candidates SHALL be
ineligible when the same exchange also has an active operational reference.
Legacy backups that predate the table SHALL have an explicit compatibility
rule rather than silently losing or inventing rows.

## Acceptance criteria

- A failing-first extraction test rejects an invented reference and accepts a
  source-verbatim one; a real local-model probe covers concrete reference
  examples and a true named function rename without a forged system field.
- A disposable local Compose fixture proves trusted org/project/session/
  exchange persistence, foreign and suppressed exclusion, recent and lexical
  SessionStart recall, and API visibility.
- A clean-target backup/restore fixture preserves the new rows, while session
  inventory and shadow SQL fixtures count them and preserve exact scope.
- Recheck the unchanged 26 required anchors from the 21 previously failed
  Tier-C cases and report the exact outcome, plus false positive examples.
  This is an extraction diagnostic, not a full Tier-C or judged Tier-A result.
  Request pruning SHALL stay disabled until its existing full gates pass.
