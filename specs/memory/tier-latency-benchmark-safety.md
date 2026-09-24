# Tier latency benchmark isolation

**Scope:** the existing `bench:tiers` operator command for the v0.5 memory
latency gate. A local Compose result is development evidence; the blueprint's
Tier-2 <50 ms p95 release target still needs representative deployment timing.

## REQ-1 — Require explicit database binding

WHEN `bench:tiers` starts, THE COMMAND SHALL require `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY` from its inherited process environment before it warms
an encoder or times any tier. IF either is absent, THEN it SHALL exit nonzero
with no PASS result. It SHALL NOT load a `.env` file implicitly.

## REQ-2 — Own benchmark rows

WHEN database timing begins, THE COMMAND SHALL create a fresh organization
with an ID minted for that invocation and SHALL NOT select or reuse an
organization by a shared name. It SHALL only delete rows under that minted ID
if its own insert succeeded. A pre-existing organization with the historical
benchmark name and its rows SHALL remain untouched.

## REQ-3 — Verify cleanup

WHEN the benchmark exits after creating its organization, THE COMMAND SHALL
check deletion results for its warm facts, session, vector, graph-edge,
graph-entity, and organization rows and fail if cleanup cannot complete. The
Tier-2 timing SHALL query a seeded, nonempty warm fact set and verify that the
bounded result contains 20 rows before timing it. The measurement summary
SHALL distinguish local development results from a deployment gate.

## Acceptance criteria

- A failing-first no-credentials process check exits before ONNX model startup
  and never prints PASS.
- A failing-first local Compose fixture creates an organization named
  `Bench Tiers Org`, runs the benchmark, then confirms that organization and
  its marker row still exist and no new benchmark organization remains. It
  also requires a verified 20-row warm result from the benchmark.
- The benchmark measures all tiers on local Compose and reports the exact
  observed p95/p99 values and verdict. These do not satisfy the representative
  deployment target by themselves.
