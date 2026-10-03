# Historical claim dispositions

**Spec ID**: ops/claim-retirement
**Status**: draft (bounded ledger action under the owner's instruction to continue the remaining work; does not approve the wider masterpiece specification)
**Last updated**: 2026-10-03

## Context and authority

Payment removal schedules a separate historical ledger action; the naming spec
REQ-5 sends older proof commands to that action. PB-105 names twelve claims from
discarded or uncommitted runtime-move attempts. The owner has instructed the
agent to continue the remaining roadmap without further questions.

This document specifies the bounded record of dispositions. It does not change
the claim validator or declare a historical command false because today's
product no longer implements the behavior it tested.

## Requirements

### REQ-1 (Ubiquitous): Preserve original evidence

THE LEDGER ACTION SHALL preserve the original claim YAML, proof scripts and
logs byte for byte and in their original locations.

### REQ-2 (Ubiquitous): Bind each disposition

THE DISPOSITION LEDGER SHALL record each claim's exact ID, project-relative
claim path, original file SHA-256, original Git SHA, original scope, reason,
decision authority and disposition date.

THE DISPOSITION LEDGER SHALL distinguish an obsolete product assertion from
an assertion about discarded or uncommitted work whose claimed commit does
not bind that work.

IF historical execution validity was not independently established, THEN THE
DISPOSITION LEDGER SHALL record that it was not assessed.

### REQ-3 (Unwanted behavior): Do not retire surviving behavior

IF a claim also covers surviving usage, estimates, provenance, authorization
or other behavior, THEN THE LEDGER ACTION SHALL preserve its surviving scope
and defer any unsupported whole-claim retirement for further review.

WHEN a replacement is cited, THE DISPOSITION LEDGER SHALL identify the exact
scope the replacement supports; it SHALL NOT treat the merged runtime-move
claim as a replacement for unrelated preconditions, dependency installation
or security scans.

### REQ-4 (Ubiquitous): Disposition is separate from validation

THE LEDGER ACTION SHALL publish dispositions separately from passing proof
counts. THE EXISTING VALIDATOR SHALL remain unchanged by this action.

THE LEDGER DOCUMENTATION SHALL state that the sidecar is a historical record,
not an automatic skip rule or an independently rerun proof. Mechanical
active/retired accounting and committed proof sets remain MR-10 work.

### REQ-5 (State-driven): Keep remaining gates open

WHILE broader erasure coverage, managed onboarding/restarts or the one-year
benchmark remain unverified, THE LEDGER ACTION SHALL leave those gates open.

## Acceptance criteria

- **AC-1 (REQ-1, REQ-2):** Compare each recorded claim's hash and original SHA
  with the original YAML; compare the before/after manifest of the historical
  YAML, scripts and logs. No historical proof command is executed.
- **AC-2 (REQ-2, REQ-3):** Independent review traces every disposition to its
  exact claim scope and governing decision. PB-105 contains the twelve IDs
  214–225; claim 219 retains its actual `8a14c5d` binding. Claim 226 is retained.
- **AC-3 (REQ-3, REQ-4):** Mixed or uncertain candidates have explicit deferral
  reasons. The validator/schema are byte-identical and documentation states
  that retired records do not add to the passing count.
- **AC-4 (REQ-5):** Current handoff documentation distinguishes the merged
  initial erasure class from the wider open coverage/lifecycle/benchmark gates.

**Verified by:** a recorded, read-only data comparison and independent review
of the final ledger and its source manifest; no historical command reruns.

## Falsified by

- A rewritten, moved or deleted historical claim, proof script or log.
- A disposition whose identity or original hash does not match its evidence.
- A retired mixed claim without a surviving-scope disposition.
- Treating a ledger row as a passing proof, or treating this action as closing
  the broader erasure or release gates.

## Out of scope

Changing `verification/claim-validator.ts` or `verification/claim-schema.yml`,
repairing or rerunning old proof commands, publishing historical logs, changing
test floors, and implementing MR-10's committed proof set and validation rules.
