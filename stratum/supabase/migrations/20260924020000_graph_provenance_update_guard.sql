-- Provenance completeness is monotonic: an untracked write makes a graph row
-- uncertain, and an incomplete historical row cannot be upgraded by UPDATE.
CREATE FUNCTION public.guard_graph_provenance_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT OLD.provenance_complete AND NEW.provenance_complete THEN
    RAISE EXCEPTION 'graph provenance cannot be upgraded after insertion';
  END IF;
  IF (to_jsonb(NEW) - 'provenance_complete') IS DISTINCT FROM
     (to_jsonb(OLD) - 'provenance_complete') THEN
    NEW.provenance_complete := false;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_graph_entity_provenance_update_guard
  BEFORE UPDATE ON public.knowledge_entities
  FOR EACH ROW EXECUTE FUNCTION public.guard_graph_provenance_update();
CREATE TRIGGER trg_graph_edge_provenance_update_guard
  BEFORE UPDATE ON public.knowledge_edges
  FOR EACH ROW EXECUTE FUNCTION public.guard_graph_provenance_update();

REVOKE EXECUTE ON FUNCTION public.guard_graph_provenance_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_graph_provenance_update() TO service_role;
