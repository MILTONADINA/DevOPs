-- Composite FKs bind the organization and IDs; also require the referenced
-- entity to be a canonical File and the fact to be active at the same path.
CREATE FUNCTION public.validate_source_fact_link()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE valid_link BOOLEAN;
BEGIN
  IF NEW.function_change_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.knowledge_entities e
      JOIN public.function_changes f ON f.org_id = e.org_id AND f.id = NEW.function_change_id
      WHERE e.org_id = NEW.org_id AND e.id = NEW.file_entity_id
        AND e.kind = 'File' AND e.name = e.file_path
        AND f.file_path = e.name AND NOT f.is_suppressed
    ) INTO valid_link;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.knowledge_entities e
      JOIN public.tech_decisions d ON d.org_id = e.org_id AND d.id = NEW.tech_decision_id
      WHERE e.org_id = NEW.org_id AND e.id = NEW.file_entity_id
        AND e.kind = 'File' AND e.name = e.file_path
        AND d.domain = e.name AND NOT d.is_suppressed
    ) INTO valid_link;
  END IF;
  IF NOT valid_link THEN RAISE EXCEPTION 'source fact link requires an active fact at its own indexed File path'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_source_fact_link BEFORE INSERT OR UPDATE ON public.source_fact_links
  FOR EACH ROW EXECUTE FUNCTION public.validate_source_fact_link();
