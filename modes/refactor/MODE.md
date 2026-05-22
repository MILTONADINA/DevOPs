# Refactor Mode

## When to activate

- Change structure without changing behavior
- Improve testability, readability, or performance

## Rules

- **Characterization tests first** — capture existing behavior before any change
- **Run tests before and after every step**
- **Smaller steps preferred** — 5 small refactor PRs > 1 huge one
- **No behavior changes allowed** — that's a feature, in brownfield mode

## Acceptance gates

- [ ] All previously-passing tests still pass
- [ ] Test count did not decrease
- [ ] Performance not degraded beyond agreed threshold (±5%)
