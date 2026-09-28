## Summary

<!-- What does this PR do? One paragraph. -->

## Type of Change

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `perf` — performance improvement (include benchmark numbers)
- [ ] `refactor` — code change with no behavior change
- [ ] `docs` — documentation only
- [ ] `test` — tests only
- [ ] `chore` — build, deps, tooling

## Checklist

### Always Required
- [ ] `npm run typecheck` passes (zero errors)
- [ ] `npm run lint` passes (zero warnings)
- [ ] `npm run test` passes

### Required If Pruning Logic Changed (`src/pruner/`)
- [ ] `npm run test:eval` passes (Faithfulness > 0.90, Answer Relevancy > 0.88)
- [ ] Zero failures on Tier C critical golden queries
- [ ] Benchmark: ONNX encode + KadaneDial p99 < 15ms

### Required If Schema Changed
- [ ] Migration file exists in `supabase/migrations/`
- [ ] Migration tested against local Supabase (`npx supabase db push`)
- [ ] `docs/TECHNICAL_SPEC.md` updated with new schema

### Required If Architecture Decision Was Made
- [ ] ADR exists in `docs/decisions/` with status: Accepted

### Required If Billing Logic Changed
- [ ] Second reviewer assigned (billing changes require two eyes)
- [ ] Append-only invariant tested: attempted UPDATE to `billing_records` fails
- [ ] Signed hash verified on written records

### Required If Security-Sensitive Code Changed (`src/proxy/tee/`, `src/pruner/crypto.ts`)
- [ ] ADR exists documenting the decision
- [ ] `docs/SECURITY.md` updated if threat model changes
- [ ] Verified: raw context does not appear in any logs

## Roadmap
- [ ] `docs/ROADMAP.md` phase checklist updated (if a task was completed)

## Testing Notes

<!-- How did you verify this works? What edge cases did you test? -->

## Related Issues

Closes #
