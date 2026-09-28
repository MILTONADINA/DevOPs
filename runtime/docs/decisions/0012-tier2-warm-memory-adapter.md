# ADR-0012: Tier-2 Warm-Memory Persistence Adapter

**Date:** 2026-05-29
**Status:** Accepted (implemented; live schema applied to the Stratum Supabase project + round-trip verified)

## Context

Tier-2 warm memory (per `MEMORY_ARCHITECTURE.md` + stratum CLAUDE.md) stores ~30
days of **typed structured facts** — never summaries — in Supabase Postgres. The
upstream pieces already existed and were unit-tested: the `AnyFact` type union
(`src/types/facts.ts`), the Zod validators (`src/memory/warm/schemas.ts`), and the
fact extractor (`src/memory/warm/extractor.ts`). The persistence adapter
(`src/memory/warm/tier2.ts`) was a `// TODO` stub, and the SQL schema
(`supabase/migrations/20260406000000_initial_schema.sql`) had never been applied to
a live database.

A live Supabase project (`Stratum`, ref `kdeqkijtagypiwnrwmem`) was provisioned for
exactly this. This ADR records the design chosen when wiring the adapter to it.

There is a real impedance mismatch to resolve:

- The five fact tables require `org_id UUID NOT NULL` and
  `session_id UUID NOT NULL REFERENCES sessions(id)`.
- An extracted `AnyFact` carries **no `org_id`** and only a *logical* `session_id`
  string (e.g. an app session label), not necessarily a real `sessions(id)` row.

## Decision

1. **Trusted-FK injection.** `persist(facts, ctx)` takes a `PersistContext`
   `{ orgId, sessionId }` of **server-resolved DB foreign keys**. Those values
   always override any `org_id`/`session_id` carried on the fact. This is the same
   forgery-prevention principle the extractor already enforces (ADR-adjacent to the
   `SYSTEM_FIELDS` strip): identity/provenance/relationship keys come from trusted
   server context, never from (untrusted) model-derived fact content.
   `developer_id` / `supersedes_id` / `assigned_to` are likewise resolved
   server-side; the extractor strips them, so absent → written as SQL `NULL`.

2. **Table-per-fact-type routing.** A static `FACT_TABLES` map routes each
   `fact_type` to its table; `TABLE_FACT_TYPES` is the reverse for reads. Writes are
   **grouped by table and batch-inserted** (one insert per table). Because every row
   in a batch shares the trusted FKs, a batch failure is systemic (bad FK /
   connection) and applies to the whole group — so per-table error attribution in
   `PersistResult.errors` is accurate.

3. **FAIL-CLOSED on write *and* read.** Every fact is re-validated with
   `validateFact` before insert (defense in depth — invalid → counted in `skipped`,
   never written). On read, `rowToFact` reconstructs the discriminated union,
   coerces SQL `NULL`s to absent (Zod `.optional()` rejects `null`), drops non-fact
   columns (`org_id`, `promoted_to_t3`), and validates again — a row that fails the
   schema is dropped, not returned.

4. **Pure projection seam.** `tableForFactType` / `factToRow` / `rowToFact` are pure
   and exported, unit-tested with **no live client** (same injectable-seam pattern as
   the extractor and the eval judge). `createWarmMemory(client)` wires them to a
   Supabase client. The live round-trip is a **separately-gated** script
   (`scripts/verify-tier2.ts`, gated on `SUPABASE_SERVICE_KEY`).

5. **Reads must not silently partial.** `queryRecent` fans out across the five
   tables in parallel; if **any** read errors it throws (a silent partial would look
   like "no memory" and mislead the caller). Results merge newest-first and cap at
   `limit`.

## Consequences

- The adapter requires the caller to have already resolved a real `organizations`
  row and `sessions` row. Wiring that resolution into the proxy's request lifecycle
  (create-or-get org/session) is a **separate** step, deferred to the proxy
  integration task (it is not part of the off-path eviction→extract→persist flow
  this adapter serves).
- The service-role key is assumed (it bypasses RLS). All 13 tables have RLS enabled
  with no policies (the secure deny-by-default posture for a service-only backend);
  see **PB-31** for the follow-up to author explicit RLS policies if anon/edge
  access is ever introduced, and to review the platform `rls_auto_enable()`
  SECURITY DEFINER function the Supabase↔Vercel integration installed.
- The migration was applied to the live project via the Supabase MCP
  `apply_migration` (the repo's `db:push` path needs the DB password + a linked CLI,
  unavailable here). The live schema therefore matches the repo SQL but its
  `supabase_migrations` version row was minted by the MCP, not the repo filename
  timestamp — a benign divergence noted for the eventual CLI-linked workflow.
- Pruning/memory is still NOT in the request path; this adapter is warm-tier
  persistence, exercised off-path on Tier-1 eviction. No constitution gate is
  crossed by landing it.

## Alternatives Considered

- **Per-fact insert (one round-trip each)** — simpler error isolation, but N
  round-trips per eviction. Rejected in favor of per-table batch (facts are
  pre-validated; batch failure is systemic, so isolation is not lost in practice).
- **A single polymorphic `facts` table with a JSONB payload** — rejected: it throws
  away the typed columns + CHECK constraints + per-type FKs (`supersedes_id`,
  `assigned_to`) the schema deliberately models, and violates "schema design is not
  a shortcut" (CLAUDE.md).
- **Trusting the fact's own `session_id`/`org_id`** — rejected: it is model-derived,
  forgeable, and not guaranteed to be a real FK. Trusted context must win.
