-- File insertion and migration backfill find active facts by organization/path.
CREATE INDEX function_changes_active_source_idx ON public.function_changes(org_id, file_path)
  WHERE NOT is_suppressed AND file_path IS NOT NULL;
CREATE INDEX tech_decisions_active_source_idx ON public.tech_decisions(org_id, domain)
  WHERE NOT is_suppressed;
