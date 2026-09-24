-- Old graph rows lack trustworthy project identity. Keep them available to
-- personal mode but exclude them from commercial project reads.
ALTER TABLE public.knowledge_entities
  ADD COLUMN project_scope text,
  ADD COLUMN scope_verified boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT knowledge_entities_project_scope_format CHECK
    (project_scope IS NULL OR project_scope ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$');
ALTER TABLE public.knowledge_edges
  ADD COLUMN project_scope text,
  ADD COLUMN scope_verified boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT knowledge_edges_project_scope_format CHECK
    (project_scope IS NULL OR project_scope ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$');
ALTER TABLE public.knowledge_entities DROP CONSTRAINT knowledge_entities_org_id_kind_name_key;
CREATE UNIQUE INDEX knowledge_entities_verified_identity
  ON public.knowledge_entities (org_id, project_scope, kind, name) NULLS NOT DISTINCT
  WHERE scope_verified;
CREATE UNIQUE INDEX knowledge_entities_uncertain_identity
  ON public.knowledge_entities (org_id, kind, name) WHERE NOT scope_verified;
CREATE INDEX knowledge_entities_project_recent
  ON public.knowledge_entities (org_id, project_scope, created_at DESC) WHERE scope_verified;
CREATE INDEX knowledge_edges_project_recent
  ON public.knowledge_edges (org_id, project_scope, created_at DESC) WHERE scope_verified;

CREATE FUNCTION public.guard_graph_project_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE session_scope text; from_scope text; to_scope text;
        from_verified boolean; to_verified boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.project_scope, NEW.scope_verified) IS DISTINCT FROM
     (OLD.project_scope, OLD.scope_verified) THEN
    RAISE EXCEPTION 'graph project identity is immutable';
  END IF;
  IF NEW.session_id IS NOT NULL THEN
    SELECT project_scope INTO session_scope FROM public.sessions
      WHERE id = NEW.session_id AND org_id = NEW.org_id;
    IF NOT FOUND OR (NEW.scope_verified AND NEW.project_scope IS DISTINCT FROM session_scope)
       OR (NOT NEW.scope_verified AND session_scope IS NOT NULL) THEN
      RAISE EXCEPTION 'graph session project mismatch';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'knowledge_edges' THEN
    SELECT project_scope, scope_verified INTO from_scope, from_verified
      FROM public.knowledge_entities WHERE id = NEW.from_entity AND org_id = NEW.org_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'graph source entity missing'; END IF;
    SELECT project_scope, scope_verified INTO to_scope, to_verified
      FROM public.knowledge_entities WHERE id = NEW.to_entity AND org_id = NEW.org_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'graph target entity missing'; END IF;
    IF NEW.scope_verified IS DISTINCT FROM from_verified
       OR NEW.scope_verified IS DISTINCT FROM to_verified
       OR NEW.project_scope IS DISTINCT FROM from_scope
       OR NEW.project_scope IS DISTINCT FROM to_scope THEN
      RAISE EXCEPTION 'graph edge project mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_graph_entity_project_scope
  BEFORE INSERT OR UPDATE OF org_id, session_id, project_scope, scope_verified
  ON public.knowledge_entities FOR EACH ROW EXECUTE FUNCTION public.guard_graph_project_scope();
CREATE TRIGGER guard_graph_edge_project_scope
  BEFORE INSERT OR UPDATE OF org_id, session_id, from_entity, to_entity, project_scope, scope_verified
  ON public.knowledge_edges FOR EACH ROW EXECUTE FUNCTION public.guard_graph_project_scope();

CREATE FUNCTION public.guard_graph_session_link_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE session_scope text; row_scope text; verified boolean;
BEGIN
  SELECT project_scope INTO session_scope FROM public.sessions
    WHERE id = NEW.session_id AND org_id = NEW.org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'graph provenance session missing'; END IF;
  IF TG_TABLE_NAME = 'knowledge_entity_sessions' THEN
    SELECT project_scope, scope_verified INTO row_scope, verified
      FROM public.knowledge_entities WHERE id = NEW.entity_id AND org_id = NEW.org_id;
  ELSE
    SELECT project_scope, scope_verified INTO row_scope, verified
      FROM public.knowledge_edges WHERE id = NEW.edge_id AND org_id = NEW.org_id;
  END IF;
  IF NOT FOUND OR (verified AND row_scope IS DISTINCT FROM session_scope)
     OR (NOT verified AND session_scope IS NOT NULL) THEN
    RAISE EXCEPTION 'graph provenance project mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_graph_entity_session_link_scope
  BEFORE INSERT OR UPDATE ON public.knowledge_entity_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_graph_session_link_scope();
CREATE TRIGGER guard_graph_edge_session_link_scope
  BEFORE INSERT OR UPDATE ON public.knowledge_edge_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_graph_session_link_scope();

-- File-to-fact links must use the same project on both sides. Retain old rows
-- for personal-mode recovery; they are not used by commercial graph reads.
CREATE FUNCTION public.guard_source_fact_link_project_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE file_scope text; fact_scope text; file_verified boolean;
BEGIN
  SELECT project_scope, scope_verified INTO file_scope, file_verified
    FROM public.knowledge_entities WHERE id = NEW.file_entity_id AND org_id = NEW.org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'source link File missing'; END IF;
  IF NEW.function_change_id IS NOT NULL THEN
    SELECT project_scope INTO fact_scope FROM public.function_changes
      WHERE id = NEW.function_change_id AND org_id = NEW.org_id;
  ELSE
    SELECT project_scope INTO fact_scope FROM public.tech_decisions
      WHERE id = NEW.tech_decision_id AND org_id = NEW.org_id;
  END IF;
  IF NOT FOUND OR file_scope IS DISTINCT FROM fact_scope
     OR (NOT file_verified AND fact_scope IS NOT NULL) THEN
    RAISE EXCEPTION 'source link project mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_source_fact_link_project_scope
  BEFORE INSERT OR UPDATE ON public.source_fact_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_source_fact_link_project_scope();

CREATE OR REPLACE FUNCTION public.sync_function_change_source_link()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE file_id uuid;
BEGIN
  IF NOT NEW.is_suppressed AND NEW.file_path IS NOT NULL THEN
    SELECT e.id INTO file_id FROM public.knowledge_entities e
      WHERE e.org_id = NEW.org_id AND e.scope_verified
        AND e.project_scope IS NOT DISTINCT FROM NEW.project_scope
        AND e.kind = 'File' AND e.name = NEW.file_path AND e.file_path = NEW.file_path LIMIT 1;
  END IF;
  DELETE FROM public.source_fact_links l WHERE l.function_change_id = NEW.id
    AND (l.org_id <> NEW.org_id OR l.file_entity_id IS DISTINCT FROM file_id);
  IF file_id IS NOT NULL THEN
    INSERT INTO public.source_fact_links(org_id, file_entity_id, function_change_id)
      VALUES (NEW.org_id, file_id, NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.sync_tech_decision_source_link()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE file_id uuid;
BEGIN
  IF NOT NEW.is_suppressed THEN
    SELECT e.id INTO file_id FROM public.knowledge_entities e
      WHERE e.org_id = NEW.org_id AND e.scope_verified
        AND e.project_scope IS NOT DISTINCT FROM NEW.project_scope
        AND e.kind = 'File' AND e.name = NEW.domain AND e.file_path = NEW.domain LIMIT 1;
  END IF;
  DELETE FROM public.source_fact_links l WHERE l.tech_decision_id = NEW.id
    AND (l.org_id <> NEW.org_id OR l.file_entity_id IS DISTINCT FROM file_id);
  IF file_id IS NOT NULL THEN
    INSERT INTO public.source_fact_links(org_id, file_entity_id, tech_decision_id)
      VALUES (NEW.org_id, file_id, NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.sync_file_source_links()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.org_id, OLD.kind, OLD.name, OLD.file_path) IS NOT DISTINCT FROM
       (NEW.org_id, NEW.kind, NEW.name, NEW.file_path) THEN RETURN NEW; END IF;
    DELETE FROM public.source_fact_links WHERE file_entity_id = OLD.id;
  END IF;
  IF NEW.kind = 'File' AND NEW.name = NEW.file_path AND NEW.scope_verified THEN
    INSERT INTO public.source_fact_links(org_id, file_entity_id, function_change_id)
      SELECT NEW.org_id, NEW.id, f.id FROM public.function_changes f
      WHERE f.org_id = NEW.org_id AND f.project_scope IS NOT DISTINCT FROM NEW.project_scope
        AND f.file_path = NEW.name AND NOT f.is_suppressed ON CONFLICT DO NOTHING;
    INSERT INTO public.source_fact_links(org_id, file_entity_id, tech_decision_id)
      SELECT NEW.org_id, NEW.id, d.id FROM public.tech_decisions d
      WHERE d.org_id = NEW.org_id AND d.project_scope IS NOT DISTINCT FROM NEW.project_scope
        AND d.domain = NEW.name AND NOT d.is_suppressed ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
