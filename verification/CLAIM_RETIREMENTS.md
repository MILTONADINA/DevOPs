# Historical claim dispositions

[`governance/claim-retirements.json`](../governance/claim-retirements.json)
records bounded historical dispositions under
[`specs/ops/claim-retirement.md`](../specs/ops/claim-retirement.md).

## Meaning

A retired claim is no longer evidence for the current product or the named
delivery. Its original YAML, scripts and logs remain in place. The ledger
records the original identity and SHA-256 so later review can detect changes.

The disposition distinguishes these reasons:

- **Superseded attempt:** the record is no longer accepted as the durable
  runtime-move delivery record. Its independent preconditions or observations
  are not declared false; historical validity was not reassessed.
- **Obsolete scope:** the claimed payment behavior has deliberately been
  removed. This does not make a historically correct claim false.

Each entry states whether historical execution validity was assessed. A
replacement reference supports only its stated scope. In particular, claim
226 records the merged runtime directory move; it does not prove unrelated
preconditions, dependency installation or security scan assertions.

Mixed claims and claims lacking enough evidence for a whole-claim disposition
are recorded as deferred candidates. Surviving token counts, estimates, usage
replay, authorization and provenance remain requirements.

## Validation behavior remains unchanged

The sidecar is a historical record. The current claim validator does not read
it, does not skip retired IDs, and does not count a disposition as a passing
proof. `--all --no-rerun` still validates the YAMLs it discovers; it does not
execute their commands or prove their behavior. MR-10 separately owns
mechanical active/retired accounting and a committed proof set.

This ledger does not publish old logs or authorize running old commands. Before
any future rerun, inspect the command, source binding, environment and side
effects. A historical `stratum/` path alone does not establish invalidity.

## Remaining gates

C4-A's schema retirement and C4-B's controlled explicit-session erasure are
merged. Broader erasure coverage, managed onboarding/restarts and the
representative one-year benchmark remain open. This ledger closes none of
those gates and makes no release or overall project completion claim.
