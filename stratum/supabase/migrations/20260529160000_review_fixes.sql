-- Migration: 20260529160000_review_fixes.sql
-- Corrective fixes from the Session-17 adversarial review of the memory subsystem.
--
-- (1) Enum CHECK mismatches (silent-loss traps): the initial schema allowed more
--     change_type / policy_type values than the TypeScript types + Zod schemas
--     accept, so a DB row with an out-of-range value would pass the DB CHECK but be
--     silently DROPPED by rowToFact (validateFact -> null) on read — violating
--     FAIL-CLOSED. Narrow the DB CHECKs to match the app layer (the extractor only
--     emits these values; promote/understand don't depend on the extras). Widening
--     later must change BOTH layers together.
--
-- (2) REVOKE ... FROM PUBLIC: the prior migrations did `REVOKE EXECUTE ... FROM
--     anon, authenticated`, which does NOT remove the implicit default
--     `GRANT EXECUTE ... TO PUBLIC` — so anon/authenticated still inherited EXECUTE
--     (confirmed live: has_function_privilege('anon', ...) = true). RLS on the
--     underlying tables + SECURITY INVOKER already prevented data access, but the
--     intended lockdown failed. Revoke from PUBLIC and grant explicitly to
--     service_role.

-- ── (1) Narrow enum CHECKs to match src/types/facts.ts + src/memory/warm/schemas.ts ──

ALTER TABLE function_changes DROP CONSTRAINT function_changes_change_type_check;
ALTER TABLE function_changes ADD CONSTRAINT function_changes_change_type_check
  CHECK (change_type IN ('deprecated', 'renamed', 'signature_changed'));

ALTER TABLE policy_updates DROP CONSTRAINT policy_updates_policy_type_check;
ALTER TABLE policy_updates ADD CONSTRAINT policy_updates_policy_type_check
  CHECK (policy_type IN ('security', 'compliance', 'process'));

-- ── (2) Lock down the SECURITY-relevant RPC functions to service_role only ──

REVOKE EXECUTE ON FUNCTION public.find_superseded(uuid, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.entity_status(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.match_memory_vectors(vector, uuid, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.find_superseded(uuid, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_status(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_memory_vectors(vector, uuid, integer) TO service_role;
