-- A typed fact may identify the completed commercial exchange that produced it.
-- The UUID carries no raw turn content and remains NULL for legacy memory facts.
CREATE FUNCTION public.check_warm_fact_exchange() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.source_exchange_id IS DISTINCT FROM OLD.source_exchange_id OR
       NEW.session_id IS DISTINCT FROM OLD.session_id THEN
      RAISE EXCEPTION 'warm fact exchange and session provenance is immutable';
    END IF;
  END IF;
  IF NEW.source_exchange_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.id = NEW.session_id AND s.org_id = NEW.org_id AND s.kind = 'conversation'
  ) THEN
    RAISE EXCEPTION 'warm fact exchange requires its conversation session';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.check_warm_fact_exchange() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE fact_table text;
BEGIN
  FOREACH fact_table IN ARRAY ARRAY['function_changes', 'tech_decisions',
    'policy_updates', 'todos', 'variable_changes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN source_exchange_id uuid', fact_table);
    EXECUTE format('CREATE INDEX %I ON public.%I (org_id, session_id, source_exchange_id) WHERE source_exchange_id IS NOT NULL',
      fact_table || '_exchange_idx', fact_table);
    EXECUTE format('CREATE TRIGGER check_warm_fact_exchange BEFORE INSERT OR UPDATE OF source_exchange_id, session_id ON public.%I FOR EACH ROW EXECUTE FUNCTION public.check_warm_fact_exchange()', fact_table);
  END LOOP;
END;
$$;
