-- Durable, organization-bound File -> active Tier-2 fact links.
-- The File and fact retain their own identities; the graph sidebar reads this edge table.
ALTER TABLE public.function_changes ADD CONSTRAINT function_changes_org_id_id_key UNIQUE (org_id, id);

CREATE TABLE public.source_fact_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  file_entity_id UUID NOT NULL,
  function_change_id UUID,
  tech_decision_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_fact_links_one_fact CHECK ((function_change_id IS NOT NULL) <> (tech_decision_id IS NOT NULL)),
  CONSTRAINT source_fact_links_file_fkey FOREIGN KEY (org_id, file_entity_id)
    REFERENCES public.knowledge_entities(org_id, id) ON DELETE CASCADE,
  CONSTRAINT source_fact_links_change_fkey FOREIGN KEY (org_id, function_change_id)
    REFERENCES public.function_changes(org_id, id) ON DELETE CASCADE,
  CONSTRAINT source_fact_links_decision_fkey FOREIGN KEY (org_id, tech_decision_id)
    REFERENCES public.tech_decisions(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX source_fact_links_change_unique ON public.source_fact_links(file_entity_id, function_change_id)
  WHERE function_change_id IS NOT NULL;
CREATE UNIQUE INDEX source_fact_links_decision_unique ON public.source_fact_links(file_entity_id, tech_decision_id)
  WHERE tech_decision_id IS NOT NULL;
CREATE INDEX source_fact_links_file_idx ON public.source_fact_links(org_id, file_entity_id);
ALTER TABLE public.source_fact_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.source_fact_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.source_fact_links TO service_role;

CREATE FUNCTION public.sync_function_change_source_link()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE file_id UUID;
BEGIN
  IF NOT NEW.is_suppressed AND NEW.file_path IS NOT NULL THEN
    SELECT e.id INTO file_id FROM public.knowledge_entities e
      WHERE e.org_id = NEW.org_id AND e.kind = 'File'
        AND e.name = NEW.file_path AND e.file_path = NEW.file_path LIMIT 1;
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
CREATE TRIGGER sync_function_change_source_link AFTER INSERT OR UPDATE ON public.function_changes
  FOR EACH ROW EXECUTE FUNCTION public.sync_function_change_source_link();

CREATE FUNCTION public.sync_tech_decision_source_link()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE file_id UUID;
BEGIN
  IF NOT NEW.is_suppressed THEN
    SELECT e.id INTO file_id FROM public.knowledge_entities e
      WHERE e.org_id = NEW.org_id AND e.kind = 'File'
        AND e.name = NEW.domain AND e.file_path = NEW.domain LIMIT 1;
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
CREATE TRIGGER sync_tech_decision_source_link AFTER INSERT OR UPDATE ON public.tech_decisions
  FOR EACH ROW EXECUTE FUNCTION public.sync_tech_decision_source_link();

CREATE FUNCTION public.sync_file_source_links()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.org_id, OLD.kind, OLD.name, OLD.file_path) IS NOT DISTINCT FROM
       (NEW.org_id, NEW.kind, NEW.name, NEW.file_path) THEN RETURN NEW; END IF;
    DELETE FROM public.source_fact_links WHERE file_entity_id = OLD.id;
  END IF;
  IF NEW.kind = 'File' AND NEW.name = NEW.file_path THEN
    INSERT INTO public.source_fact_links(org_id, file_entity_id, function_change_id)
      SELECT NEW.org_id, NEW.id, f.id FROM public.function_changes f
      WHERE f.org_id = NEW.org_id AND f.file_path = NEW.name AND NOT f.is_suppressed
      ON CONFLICT DO NOTHING;
    INSERT INTO public.source_fact_links(org_id, file_entity_id, tech_decision_id)
      SELECT NEW.org_id, NEW.id, d.id FROM public.tech_decisions d
      WHERE d.org_id = NEW.org_id AND d.domain = NEW.name AND NOT d.is_suppressed
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sync_file_source_links AFTER INSERT OR UPDATE OF org_id, kind, name, file_path
  ON public.knowledge_entities FOR EACH ROW EXECUTE FUNCTION public.sync_file_source_links();

-- Existing rows may predate this migration; link only active exact indexed paths.
INSERT INTO public.source_fact_links(org_id, file_entity_id, function_change_id)
  SELECT e.org_id, e.id, f.id FROM public.knowledge_entities e
  JOIN public.function_changes f ON f.org_id = e.org_id AND f.file_path = e.name
  WHERE e.kind = 'File' AND e.file_path = e.name AND NOT f.is_suppressed
  ON CONFLICT DO NOTHING;
INSERT INTO public.source_fact_links(org_id, file_entity_id, tech_decision_id)
  SELECT e.org_id, e.id, d.id FROM public.knowledge_entities e
  JOIN public.tech_decisions d ON d.org_id = e.org_id AND d.domain = e.name
  WHERE e.kind = 'File' AND e.file_path = e.name AND NOT d.is_suppressed
  ON CONFLICT DO NOTHING;

CREATE FUNCTION public.list_source_related_facts(match_org UUID, match_file UUID, result_limit INTEGER DEFAULT 50)
RETURNS TABLE(id UUID, kind TEXT, summary TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT fact.id, fact.kind, fact.summary, fact.created_at FROM (
    SELECT f.id, 'FunctionChange'::text AS kind,
      f.old_name || CASE WHEN f.new_name IS NOT NULL AND f.new_name <> '' THEN ' → ' || f.new_name ELSE '' END
        || ' (' || f.change_type || ')' AS summary, f.created_at
    FROM public.source_fact_links l
    JOIN public.function_changes f ON f.org_id = l.org_id AND f.id = l.function_change_id
    WHERE l.org_id = match_org AND l.file_entity_id = match_file AND NOT f.is_suppressed
    UNION ALL
    SELECT d.id, 'TechDecision'::text, d.decision_text, d.created_at
    FROM public.source_fact_links l
    JOIN public.tech_decisions d ON d.org_id = l.org_id AND d.id = l.tech_decision_id
    WHERE l.org_id = match_org AND l.file_entity_id = match_file AND NOT d.is_suppressed
  ) fact ORDER BY fact.created_at DESC, fact.id LIMIT LEAST(GREATEST(result_limit, 0), 50);
$$;
REVOKE EXECUTE ON FUNCTION public.list_source_related_facts(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_source_related_facts(UUID, UUID, INTEGER) TO service_role;
