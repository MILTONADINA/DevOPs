-- A decision replacement is a reviewed, immutable assertion, never a model output.
-- Fail closed on legacy links: they lack review evidence and cannot be promoted
-- into trusted SessionStart supersession without an operator migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tech_decisions WHERE supersedes_id IS NOT NULL) THEN
    RAISE EXCEPTION 'reviewed supersession migration requires reconciliation of legacy links';
  END IF;
END;
$$;

ALTER TABLE public.tech_decisions
  ADD COLUMN supersession_reviewer text,
  ADD COLUMN supersession_evidence text,
  ADD COLUMN supersession_reviewed_at timestamptz,
  ADD CONSTRAINT tech_decisions_reviewed_link CHECK (
    (supersedes_id IS NULL AND supersession_reviewer IS NULL AND supersession_evidence IS NULL AND supersession_reviewed_at IS NULL)
    OR (supersedes_id IS NOT NULL
      AND coalesce(length(btrim(supersession_reviewer)), 0) >= 3
      AND coalesce(length(btrim(supersession_evidence)), 0) >= 20
      AND supersession_reviewed_at IS NOT NULL)
  );

CREATE UNIQUE INDEX tech_decisions_one_successor
  ON public.tech_decisions (org_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE FUNCTION public.guard_reviewed_decision_supersession() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE older_scope text; older_created_at timestamptz; older_suppressed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.supersedes_id IS NOT NULL AND
       (NEW.supersedes_id, NEW.supersession_reviewer, NEW.supersession_evidence, NEW.supersession_reviewed_at)
       IS DISTINCT FROM
       (OLD.supersedes_id, OLD.supersession_reviewer, OLD.supersession_evidence, OLD.supersession_reviewed_at) THEN
      RAISE EXCEPTION 'reviewed decision supersession is immutable';
    END IF;
    IF (NEW.org_id, NEW.project_scope, NEW.created_at, NEW.session_id)
       IS DISTINCT FROM (OLD.org_id, OLD.project_scope, OLD.created_at, OLD.session_id)
       AND (OLD.supersedes_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM public.tech_decisions successor WHERE successor.supersedes_id = OLD.id
       )) THEN
      RAISE EXCEPTION 'linked decision identity is immutable';
    END IF;
  END IF;

  IF NEW.supersedes_id IS NOT NULL THEN
    IF NEW.supersedes_id = NEW.id THEN
      RAISE EXCEPTION 'decision cannot supersede itself';
    END IF;
    SELECT project_scope, created_at, is_suppressed
      INTO older_scope, older_created_at, older_suppressed
      FROM public.tech_decisions
      WHERE id = NEW.supersedes_id AND org_id = NEW.org_id;
    IF NOT FOUND OR older_scope IS DISTINCT FROM NEW.project_scope THEN
      RAISE EXCEPTION 'superseded decision organization or project mismatch';
    END IF;
    IF older_suppressed OR NEW.is_suppressed OR NEW.created_at <= older_created_at THEN
      RAISE EXCEPTION 'supersession requires active older decision and later active replacement';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_reviewed_decision_supersession
  BEFORE INSERT OR UPDATE OF supersedes_id, supersession_reviewer,
    supersession_evidence, supersession_reviewed_at, org_id, project_scope,
    created_at, session_id
  ON public.tech_decisions FOR EACH ROW
  EXECUTE FUNCTION public.guard_reviewed_decision_supersession();
REVOKE EXECUTE ON FUNCTION public.guard_reviewed_decision_supersession() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.review_tech_decision_supersession(
  match_org uuid, match_project_scope text, newer_id uuid, older_id uuid,
  reviewer text, evidence text
) RETURNS uuid
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE linked uuid;
BEGIN
  UPDATE public.tech_decisions
    SET supersedes_id = older_id,
        supersession_reviewer = reviewer,
        supersession_evidence = evidence,
        supersession_reviewed_at = statement_timestamp()
    WHERE id = newer_id AND org_id = match_org
      AND project_scope IS NOT DISTINCT FROM match_project_scope
      AND supersedes_id IS NULL AND NOT is_suppressed
    RETURNING id INTO linked;
  IF linked IS NULL THEN
    RAISE EXCEPTION 'newer active decision missing, scope mismatch, or already linked';
  END IF;
  RETURN linked;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.review_tech_decision_supersession(uuid, text, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_tech_decision_supersession(uuid, text, uuid, uuid, text, text)
  TO service_role;
