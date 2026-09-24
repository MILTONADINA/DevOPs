# Project-bound supersession lookup for shadow pruning

**Scope:** Prepare the existing Tier-3 supersession relation for a commercial
shadow pruner that has an authenticated organization and project. This lookup
SHALL NOT alter forwarded messages or activate pruning. Tier-C and judged
Tier-A gates remain required.

## REQ-1 — Bound and provenance-complete relation

WHEN a trusted caller requests supersession pairs for one organization and
project, THE SYSTEM SHALL return only `SUPERSEDES` edges whose edge and both
endpoint entities belong to that exact organization and verified project.
It SHALL require complete session provenance on all three rows, and match
only requested superseded names. A null project SHALL mean the verified
unbound project, not all projects. Historical uncertain rows SHALL be excluded.

## REQ-2 — Service-only and fail closed

WHEN the project lookup is called through the graph adapter, THE SYSTEM SHALL
pass the caller's explicit organization and project values to a service-only
database function, short-circuit an empty name list, validate a non-null
project slug, and surface lookup errors. It SHALL preserve the existing
personal-mode organization-wide lookup without using it for commercial
project-bound decisions. Anonymous and authenticated database roles SHALL
have no execute privilege on the project lookup.

## Acceptance criteria

- A rolled-back local database fixture gives Orion and Vega same-named nodes
  and supersession edges with different successors, plus uncertain and
  provenance-incomplete rows. Orion, Vega, and verified unbound lookups return
  only their own complete relation; unrelated names and organizations return
  none.
- An adapter test fails before implementation and then proves exact RPC
  argument binding, empty-list short circuit, invalid project rejection, and
  error propagation.
- The default Tier-C gate remains red and no request forwarding path changes.
