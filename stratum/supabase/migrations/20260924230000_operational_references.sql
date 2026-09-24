-- Concrete source-grounded operational references use the same trusted warm
-- fact identity, project, and exchange rules as the original five fact types.
CREATE TABLE public.operational_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  session_id uuid NOT NULL REFERENCES public.sessions(id),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  developer_id uuid REFERENCES public.developers(id),
  commit_hash text,
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  is_verified boolean NOT NULL DEFAULT false,
  is_suppressed boolean NOT NULL DEFAULT false,
  promoted_to_t3 boolean NOT NULL DEFAULT false,
  project_scope text CONSTRAINT operational_references_project_scope_format
    CHECK (project_scope IS NULL OR project_scope ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  source_exchange_id uuid,
  subject text NOT NULL CHECK (length(subject) > 0),
  reference text NOT NULL CHECK (length(reference) > 0)
);

CREATE INDEX operational_references_org_project_recent_idx
  ON public.operational_references (org_id, project_scope, created_at DESC);
CREATE INDEX operational_references_exchange_idx
  ON public.operational_references (org_id, session_id, source_exchange_id)
  WHERE source_exchange_id IS NOT NULL;
CREATE INDEX operational_references_unpromoted_idx
  ON public.operational_references (org_id, created_at)
  WHERE NOT promoted_to_t3 AND NOT is_suppressed;

CREATE TRIGGER check_warm_fact_project_scope
  BEFORE INSERT OR UPDATE ON public.operational_references
  FOR EACH ROW EXECUTE FUNCTION public.check_warm_fact_project_scope();
CREATE TRIGGER check_warm_fact_exchange
  BEFORE INSERT OR UPDATE OF source_exchange_id, session_id ON public.operational_references
  FOR EACH ROW EXECUTE FUNCTION public.check_warm_fact_exchange();

ALTER TABLE public.operational_references ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.operational_references FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.operational_references TO service_role;
