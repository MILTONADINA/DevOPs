## Summary

<!-- What does this PR do? One paragraph. -->

## Spec or ADR

<!-- Every PR traces to a spec or ADR (CONTRIBUTING.md). Link it, and name the
     REQ and AC ids this PR implements or changes, for example
     specs/security/stratum-local-network.md REQ-2, AC-2. -->

## Type of Change

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `perf` — performance improvement (include benchmark numbers)
- [ ] `refactor` — code change with no behavior change
- [ ] `docs` — documentation only
- [ ] `test` — tests only
- [ ] `security` — security fix or hardening
- [ ] `chore` — maintenance with no behavior change
- [ ] `spec` — a new or changed spec
- [ ] `ci` / `build` — CI workflows, build or toolchain
- [ ] `evals` / `fixture` — eval harness or eval fixtures
- [ ] `audit` — an audit report
- [ ] `revert` — reverts an earlier change

## Checklist

### Always Required
- [ ] Conventional Commit title: `<type>(<scope>): <subject>`
- [ ] Root suite passes: `npm test`
- [ ] Proof for the change is pasted into this PR description under Testing Notes: the test command, its exit code, the output tail and the spec reference. `.workflow/proofs/` is gitignored, so do not commit files from it
- [ ] New claims validate: `npm run validate:claims -- path/to/claim.yml --no-rerun`

### Required If Stratum Code Changed (`stratum/`)
- [ ] `cd stratum && npm run typecheck` passes (zero errors)
- [ ] `cd stratum && npm run lint` passes (zero warnings)
- [ ] `cd stratum && npm test` passes

### Required If Pruning Logic Changed (`stratum/src/pruner/`)
- [ ] `cd stratum && npm run test:eval` passes
- [ ] Zero failures on Tier C critical golden queries

### Required If Schema Changed
- [ ] Migration file exists in `stratum/supabase/migrations/`
- [ ] Migration applied to the local stack (`cd stratum && npm run db:migrate`)
- [ ] `stratum/docs/TECHNICAL_SPEC.md` updated with the new schema

### Required If Architecture Decision Was Made
- [ ] ADR exists in `governance/decisions/` (or `stratum/docs/decisions/` for Stratum) with status: Accepted

### Required If Security-Sensitive Code Changed
- [ ] Threat model updated in `docs/SECURITY.md` or `docs/threat-models/`
- [ ] Verified: raw context and secrets do not appear in any logs

### Required If a Skill Changed (`skills/`)
- [ ] Eval pass recorded, and the skill re-signed if it is listed in `governance/skill-manifest.yml`

## Testing Notes

<!-- The tests you added (file and title), each command you ran with its exit
     code, and the output tail. Name any edge case you checked by hand. -->

## Related Issues

Closes #
