-- 20260530040000_audit_security_hardening.sql
-- Session-23 audit/bughunt/pentest remediation. Idempotent; brings the migration source-of-truth in line
-- with the (already-secure) live database and closes defense-in-depth gaps on the financial tables.

-- (1) RLS on every public table. Live already has this (via the rls_auto_enable DDL event trigger), but
-- the migrations only enabled it on `invoices` — so a fresh re-provision WITHOUT that trigger would expose
-- api_keys/billing_records/etc. to the anon PostgREST role. The service role bypasses RLS, so this is
-- zero-impact to the app; RLS-enabled-with-no-policy = deny-all for anon/authenticated (the documented
-- "service-role-only" posture). ENABLE is idempotent (no-op when already enabled).
ALTER TABLE IF EXISTS public.organizations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.developers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.org_config         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.pruning_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.billing_records    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.function_changes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.tech_decisions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.policy_updates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.todos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.variable_changes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.audit_conflicts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.api_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.knowledge_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.knowledge_edges    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_vectors     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.invoices           ENABLE ROW LEVEL SECURITY;

-- (2) billing_records append-only — replace the silent DO-INSTEAD-NOTHING RULES with BEFORE triggers that
-- RAISE. A RULE is bypassed by BYPASSRLS roles and NEVER fires for TRUNCATE; the financial ledger must
-- fail LOUD on any UPDATE/DELETE/TRUNCATE. BYPASSRLS does not skip triggers (only an explicit, auditable
-- ALTER TABLE ... DISABLE TRIGGER can), so this is strictly stronger than the rules it replaces.
DROP RULE IF EXISTS no_update_billing ON public.billing_records;
DROP RULE IF EXISTS no_delete_billing ON public.billing_records;

CREATE OR REPLACE FUNCTION public.billing_records_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'billing_records is append-only: % is forbidden', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_records_no_update ON public.billing_records;
CREATE TRIGGER trg_billing_records_no_update BEFORE UPDATE ON public.billing_records
  FOR EACH ROW EXECUTE FUNCTION public.billing_records_immutable();

DROP TRIGGER IF EXISTS trg_billing_records_no_delete ON public.billing_records;
CREATE TRIGGER trg_billing_records_no_delete BEFORE DELETE ON public.billing_records
  FOR EACH ROW EXECUTE FUNCTION public.billing_records_immutable();

DROP TRIGGER IF EXISTS trg_billing_records_no_truncate ON public.billing_records;
CREATE TRIGGER trg_billing_records_no_truncate BEFORE TRUNCATE ON public.billing_records
  FOR EACH STATEMENT EXECUTE FUNCTION public.billing_records_immutable();

-- (3) Lock down record_invoice_payment to service_role only (the other 3 RPCs were locked in
-- 20260529160000; this one — added later in 20260530000000 — was missed). anon/authenticated can EXECUTE
-- it today; RLS on invoices already blocks the INSERT, but REVOKE FROM PUBLIC closes the call surface too.
-- ALTER ... SET search_path pins the (advisor-flagged) role-mutable search_path WITHOUT rewriting the body.
ALTER FUNCTION public.record_invoice_payment(uuid, text, integer, text, text) SET search_path = pg_catalog, public;
REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(uuid, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_invoice_payment(uuid, text, integer, text, text) TO service_role;

-- (4) Pin the role-mutable search_path on the remaining SECURITY INVOKER read RPCs (advisor lint 0011).
ALTER FUNCTION public.find_superseded(uuid, text[])              SET search_path = pg_catalog, public;
ALTER FUNCTION public.entity_status(uuid, text)                  SET search_path = pg_catalog, public;
ALTER FUNCTION public.match_memory_vectors(vector, uuid, integer) SET search_path = pg_catalog, public;

-- (5) rls_auto_enable is a DDL event-trigger helper, never meant to be a callable RPC. Event triggers fire
-- regardless of EXECUTE grants, so revoking is safe and clears the anon/authenticated SECURITY DEFINER lint.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
