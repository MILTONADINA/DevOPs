-- Persist the key-bound project on memory sessions and typed facts. Legacy
-- sessions/facts remain NULL and are visible only to unbound commercial keys.
ALTER TABLE public.sessions ADD COLUMN project_scope text;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_project_scope_format CHECK (
  project_scope IS NULL OR project_scope ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'
);

CREATE FUNCTION public.memory_session_project_scope_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_scope IS DISTINCT FROM OLD.project_scope THEN
    RAISE EXCEPTION 'memory session project scope is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_session_project_scope_immutable
  BEFORE UPDATE OF project_scope ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.memory_session_project_scope_immutable();

CREATE FUNCTION public.check_warm_fact_project_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_org uuid;
  owner_scope text;
BEGIN
  SELECT org_id, project_scope INTO owner_org, owner_scope
    FROM public.sessions WHERE id = NEW.session_id;
  IF NOT FOUND OR NEW.org_id IS DISTINCT FROM owner_org OR
     NEW.project_scope IS DISTINCT FROM owner_scope THEN
    RAISE EXCEPTION 'warm fact organization or project scope differs from session';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE fact_table text;
BEGIN
  FOREACH fact_table IN ARRAY ARRAY['function_changes', 'tech_decisions',
    'policy_updates', 'todos', 'variable_changes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN project_scope text', fact_table);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (project_scope IS NULL OR project_scope ~ %L)',
      fact_table, fact_table || '_project_scope_format', '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$');
    EXECUTE format('CREATE INDEX %I ON public.%I (org_id, project_scope, created_at DESC)',
      fact_table || '_org_project_recent_idx', fact_table);
    EXECUTE format('CREATE TRIGGER check_warm_fact_project_scope BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.check_warm_fact_project_scope()', fact_table);
  END LOOP;
END;
$$;
