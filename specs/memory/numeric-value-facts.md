# Numeric values in extracted facts

**Scope:** real local model extraction into the existing five typed Tier-2
tables.

## REQ-1 — Preserve numeric scalar value changes

WHEN an extraction model emits a finite JSON number in `old_value` or
`new_value` for a `VariableChange` or `PolicyUpdate`, THE SYSTEM SHALL convert
that scalar to its decimal string before validating and persisting the fact.
It SHALL leave numeric `confidence` unchanged.

## REQ-2 — Keep validation and provenance boundaries

WHEN a value field is a boolean, array, or object, THE SYSTEM SHALL discard
that candidate under the existing schema. Model-supplied identity,
provenance, and verification fields SHALL remain stripped before validation.

## Acceptance criteria

- **AC-1:** a model output with `JWT_TTL_MINUTES` changing from numeric `60`
  to numeric `15` yields a validated `VariableChange` with string values.
- **AC-2:** a numeric policy old/new value also validates as text, while
  boolean and object values remain rejected.
- **AC-3:** the real local model's explicit variable change survives the
  authenticated request, local database, and SessionStart recall path.
