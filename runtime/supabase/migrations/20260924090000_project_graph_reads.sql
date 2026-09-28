-- Filter commercial graph rows before ranking, limiting, or expansion.
CREATE FUNCTION public.list_project_graph_snapshot_edges(
  match_org uuid, match_project_scope text, entity_ids uuid[], edge_limit integer
)
RETURNS TABLE(id uuid, edge_type text, from_entity uuid, to_entity uuid)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT e.id, e.edge_type, e.from_entity, e.to_entity
  FROM public.knowledge_edges e
  JOIN public.knowledge_entities source ON source.id = e.from_entity AND source.org_id = match_org
  JOIN public.knowledge_entities target ON target.id = e.to_entity AND target.org_id = match_org
  WHERE e.org_id = match_org AND e.scope_verified
    AND e.project_scope IS NOT DISTINCT FROM match_project_scope
    AND source.scope_verified AND source.project_scope IS NOT DISTINCT FROM match_project_scope
    AND target.scope_verified AND target.project_scope IS NOT DISTINCT FROM match_project_scope
    AND e.from_entity = ANY(entity_ids) AND e.to_entity = ANY(entity_ids)
  ORDER BY e.created_at DESC LIMIT LEAST(GREATEST(edge_limit, 1), 500);
$$;
REVOKE EXECUTE ON FUNCTION public.list_project_graph_snapshot_edges(uuid, text, uuid[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_project_graph_snapshot_edges(uuid, text, uuid[], integer) TO service_role;

CREATE FUNCTION public.list_project_graph_neighbor_entities(match_org uuid, match_project_scope text, entity_ids uuid[])
RETURNS SETOF public.knowledge_entities
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT e.* FROM public.knowledge_entities e
  WHERE e.org_id = match_org AND e.scope_verified
    AND e.project_scope IS NOT DISTINCT FROM match_project_scope
    AND e.id = ANY(entity_ids) LIMIT 200;
$$;
REVOKE EXECUTE ON FUNCTION public.list_project_graph_neighbor_entities(uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_project_graph_neighbor_entities(uuid, text, uuid[]) TO service_role;

CREATE FUNCTION public.search_project_graph_entities(match_org uuid, match_project_scope text, search_text text, result_limit integer)
RETURNS SETOF public.knowledge_entities
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT e.* FROM public.knowledge_entities e
  WHERE e.org_id = match_org AND e.scope_verified
    AND e.project_scope IS NOT DISTINCT FROM match_project_scope
    AND (strpos(lower(e.name), lower(search_text)) > 0 OR similarity(e.name, search_text) >= 0.2)
  ORDER BY (strpos(lower(e.name), lower(search_text)) > 0) DESC,
           similarity(e.name, search_text) DESC, e.name ASC
  LIMIT LEAST(GREATEST(result_limit, 1), 20);
$$;
REVOKE EXECUTE ON FUNCTION public.search_project_graph_entities(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_project_graph_entities(uuid, text, text, integer) TO service_role;

CREATE FUNCTION public.search_project_graph_semantic_entities(
  match_org uuid, match_project_scope text, query_embedding vector(384), result_limit integer
)
RETURNS SETOF public.knowledge_entities
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT e.* FROM public.memory_vectors v
  JOIN public.knowledge_entities e ON e.id::text = v.source_ref AND e.org_id = v.org_id
  WHERE v.org_id = match_org AND e.org_id = match_org
    AND v.source_type = 'entity' AND e.kind IN ('File', 'Function')
    AND e.scope_verified AND e.project_scope IS NOT DISTINCT FROM match_project_scope
  ORDER BY v.embedding <=> query_embedding, e.id
  LIMIT LEAST(GREATEST(result_limit, 1), 20);
$$;
REVOKE EXECUTE ON FUNCTION public.search_project_graph_semantic_entities(uuid, text, vector, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_project_graph_semantic_entities(uuid, text, vector, integer) TO service_role;

CREATE FUNCTION public.list_project_source_related_facts(
  match_org uuid, match_project_scope text, match_file uuid, result_limit integer
)
RETURNS TABLE(id uuid, kind text, summary text, created_at timestamptz)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT fact.id, fact.kind, fact.summary, fact.created_at FROM (
    SELECT f.id, 'FunctionChange'::text AS kind,
      f.old_name || CASE WHEN f.new_name IS NOT NULL AND f.new_name <> '' THEN ' → ' || f.new_name ELSE '' END
        || ' (' || f.change_type || ')' AS summary, f.created_at
    FROM public.source_fact_links l
    JOIN public.knowledge_entities e ON e.org_id = l.org_id AND e.id = l.file_entity_id
    JOIN public.function_changes f ON f.org_id = l.org_id AND f.id = l.function_change_id
    WHERE l.org_id = match_org AND l.file_entity_id = match_file
      AND e.scope_verified AND e.project_scope IS NOT DISTINCT FROM match_project_scope
      AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
    UNION ALL
    SELECT d.id, 'TechDecision'::text, d.decision_text, d.created_at
    FROM public.source_fact_links l
    JOIN public.knowledge_entities e ON e.org_id = l.org_id AND e.id = l.file_entity_id
    JOIN public.tech_decisions d ON d.org_id = l.org_id AND d.id = l.tech_decision_id
    WHERE l.org_id = match_org AND l.file_entity_id = match_file
      AND e.scope_verified AND e.project_scope IS NOT DISTINCT FROM match_project_scope
      AND d.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT d.is_suppressed
  ) fact ORDER BY fact.created_at DESC, fact.id LIMIT LEAST(GREATEST(result_limit, 0), 50);
$$;
REVOKE EXECUTE ON FUNCTION public.list_project_source_related_facts(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_project_source_related_facts(uuid, text, uuid, integer) TO service_role;
