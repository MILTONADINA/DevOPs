# Trusted project scope from commercial API keys

**Scope:** `plan.md` §3c/§3e Tier-C project isolation and the commercial
`/v1/messages` request path. This establishes a trusted scope binding; it does
not enable pruning or make the Tier-C release gate green.

## REQ-1 — Operator-bound key scope

WHEN the operator creates a commercial API key with `--project-scope`, THE
SYSTEM SHALL accept only a lowercase ASCII project slug of 1–64 characters
with alphanumeric ends and internal alphanumeric characters or hyphens. It
SHALL persist that scope beside the key hash in `api_keys`, and show the scope
in key-management output without exposing the hash. The database SHALL reject
malformed stored scopes. Existing and newly created keys without this option
SHALL remain unbound, represented by NULL. Key creation and management SHALL
use process environment credentials without loading dotenv.

## REQ-2 — Authentication as the sole binding source

WHEN a commercial request presents an active project-bound API key, THE
SYSTEM SHALL derive an internal scope ID from the authenticated organization
and stored project slug and attach it to the request. Two organizations using
the same slug SHALL have different internal scope IDs. Headers, query values,
and message content SHALL NOT override this binding. An unbound key SHALL
leave the request without a project scope. An invalid stored scope SHALL fail
authentication closed instead of downgrading to an unscoped request.

## REQ-3 — Message-path propagation without activation

WHEN a successful authenticated `/v1/messages` request records a local memory
event, THE SYSTEM SHALL include its trusted project scope when present. It
SHALL keep normal upstream forwarding and personal-use behavior unchanged. It
SHALL NOT run or apply the pruner from this binding alone.

## Acceptance criteria

- **AC-1:** focused tests reject malformed operator and stored scopes before
  a key can be treated as project-bound.
- **AC-2:** a local database check creates bound and unbound keys, verifies
  same-org and cross-org request identities through the actual auth hook,
  rejects spoofed client scope, then removes its fixture.
- **AC-3:** successful normal and streaming message tests carry the binding
  into the memory event while unbound/personal paths remain unscoped.
