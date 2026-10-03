-- specs/memory/session-erasure.md REQ-5/6/7/8/10/11/14: default-disabled authority.
-- No activation or erasure executor is installed here. The migration runner
-- supplies the transaction; existing migration history remains unchanged.

CREATE ROLE devops_erasure_executor NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION BYPASSRLS;

CREATE TABLE public.erasure_deployment (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  source_generation text NOT NULL CHECK (length(source_generation) > 0),
  activation_id uuid,
  activated_at timestamptz,
  enabled boolean NOT NULL DEFAULT false,
  CHECK (NOT enabled OR (activation_id IS NOT NULL AND activated_at IS NOT NULL))
);
INSERT INTO public.erasure_deployment(id, source_generation)
  VALUES (true, 'managed_explicit_session_v1');

-- Deliberately no organizations FK: removal/recreation cannot erase authority.
CREATE TABLE public.erasure_org_coverage (
  org_id uuid PRIMARY KEY,
  activation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  unknown_at timestamptz,
  unknown_reason text CHECK (unknown_reason IN (
    'deployment_unverified', 'legacy_org', 'protected_read', 'backup_export',
    'restore_import', 'unattributed_write', 'organization_deleted', 'unmanaged_consumer'
  )),
  CHECK ((unknown_at IS NULL) = (unknown_reason IS NULL)),
  CHECK (unknown_at IS NOT NULL OR activation_id IS NOT NULL)
);

-- No session/org FK. Only the protected coverage row anchors receipt lifetime.
CREATE TABLE public.session_erasure_state (
  org_id uuid NOT NULL REFERENCES public.erasure_org_coverage(org_id) ON DELETE RESTRICT,
  session_id uuid NOT NULL UNIQUE,
  activation_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'erasing', 'complete')),
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id uuid UNIQUE,
  prepared_at timestamptz,
  completed_at timestamptz,
  receipt jsonb,
  erased_fact_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  erased_entity_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  PRIMARY KEY (org_id, session_id),
  CHECK (array_position(erased_fact_ids, NULL) IS NULL
    AND array_position(erased_entity_ids, NULL) IS NULL),
  CHECK (
    (state = 'active' AND request_id IS NULL AND prepared_at IS NULL
      AND completed_at IS NULL AND receipt IS NULL
      AND cardinality(erased_fact_ids) = 0 AND cardinality(erased_entity_ids) = 0)
    OR (state = 'erasing' AND request_id IS NOT NULL AND prepared_at IS NOT NULL
      AND completed_at IS NULL AND receipt IS NULL
      AND cardinality(erased_fact_ids) = 0 AND cardinality(erased_entity_ids) = 0)
    OR (state = 'complete' AND request_id IS NOT NULL AND prepared_at IS NOT NULL
      AND completed_at IS NOT NULL AND receipt IS NOT NULL AND jsonb_typeof(receipt) = 'object')
  )
);
CREATE INDEX session_erasure_erased_fact_ids ON public.session_erasure_state
  USING gin (erased_fact_ids) WHERE state = 'complete';
CREATE INDEX session_erasure_erased_entity_ids ON public.session_erasure_state
  USING gin (erased_entity_ids) WHERE state = 'complete';

ALTER TABLE public.erasure_deployment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erasure_org_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_erasure_state ENABLE ROW LEVEL SECURITY;
-- The pinned image's default ACLs are broad, so additive GRANTs are insufficient.
REVOKE ALL ON TABLE public.erasure_deployment, public.erasure_org_coverage,
  public.session_erasure_state FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT ON TABLE public.erasure_deployment, public.erasure_org_coverage,
  public.session_erasure_state TO service_role;
GRANT SELECT ON TABLE public.erasure_deployment TO devops_erasure_executor;
-- FOR SHARE needs UPDATE privilege on a column; this constrained identity column
-- cannot enable or rebind a deployment. Activation columns remain operator-only.
GRANT UPDATE (id) ON TABLE public.erasure_deployment TO devops_erasure_executor;
GRANT SELECT, INSERT, UPDATE ON TABLE public.erasure_org_coverage TO devops_erasure_executor;
GRANT SELECT, INSERT ON TABLE public.session_erasure_state TO devops_erasure_executor;
GRANT SELECT, INSERT ON TABLE public.organizations, public.sessions TO devops_erasure_executor;

REVOKE TRUNCATE, TRIGGER ON TABLE
  public.api_keys, public.audit_conflicts, public.audit_statuses, public.billing_records,
  public.developers, public.function_changes, public.knowledge_edge_sessions,
  public.knowledge_edges, public.knowledge_entities, public.knowledge_entity_sessions,
  public.memory_vectors, public.operational_references, public.org_config,
  public.organizations, public.policy_updates, public.pruning_logs, public.sessions,
  public.source_fact_links, public.tech_decisions, public.todos, public.variable_changes,
  public.erasure_deployment, public.erasure_org_coverage, public.session_erasure_state
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.require_erasure_read_committed() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'erasure authority requires READ COMMITTED';
  END IF;
END;
$$;

-- Callable by invoker guards. This helper grants no positive coverage, activation,
-- enrollment or eraser bypass; its only initialization is permanently unknown.
CREATE FUNCTION public.lock_erasure_org(p_org_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'erasure organization required';
  END IF;
  PERFORM id FROM public.erasure_deployment WHERE id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'erasure authority unavailable';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('session_cap:' || p_org_id::text)::bigint);
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org_id) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'erasure organization unavailable';
  END IF;
  INSERT INTO public.erasure_org_coverage(org_id, unknown_at, unknown_reason)
    VALUES (p_org_id, pg_catalog.clock_timestamp(), 'legacy_org')
    ON CONFLICT (org_id) DO NOTHING;
END;
$$;

CREATE FUNCTION public.create_managed_organization(p_name text, p_plan text)
RETURNS SETOF public.organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  deployment public.erasure_deployment%ROWTYPE;
  created public.organizations%ROWTYPE;
  fresh_id uuid;
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF p_name IS NULL OR p_name = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'organization name required';
  END IF;
  SELECT * INTO deployment FROM public.erasure_deployment WHERE id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'erasure authority unavailable';
  END IF;
  fresh_id := pg_catalog.gen_random_uuid();
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('session_cap:' || fresh_id::text)::bigint);
  INSERT INTO public.organizations(id, name, plan) VALUES (fresh_id, p_name, p_plan)
    RETURNING * INTO created;
  IF deployment.enabled AND deployment.source_generation = 'managed_explicit_session_v1' THEN
    INSERT INTO public.erasure_org_coverage(org_id, activation_id)
      VALUES (fresh_id, deployment.activation_id);
  ELSE
    INSERT INTO public.erasure_org_coverage(org_id, unknown_at, unknown_reason)
      VALUES (fresh_id, pg_catalog.clock_timestamp(), 'deployment_unverified');
  END IF;
  RETURN NEXT created;
END;
$$;

CREATE FUNCTION public.mark_erasure_coverage_unknown(p_org_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF p_reason IS NULL OR p_reason NOT IN (
    'deployment_unverified', 'legacy_org', 'protected_read', 'backup_export',
    'restore_import', 'unattributed_write', 'organization_deleted', 'unmanaged_consumer'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported erasure uncertainty reason';
  END IF;
  PERFORM public.lock_erasure_org(p_org_id);
  IF EXISTS (SELECT 1 FROM public.session_erasure_state
    WHERE org_id = p_org_id AND state = 'erasing') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'erasure in progress; protected copy refused';
  END IF;
  UPDATE public.erasure_org_coverage
    SET unknown_at = COALESCE(unknown_at, pg_catalog.clock_timestamp()),
        unknown_reason = COALESCE(unknown_reason, p_reason)
    WHERE org_id = p_org_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_session_if_under_cap(
  p_org_id uuid, p_model text, p_cap integer
) RETURNS SETOF public.sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE created public.sessions%ROWTYPE; covered_activation uuid;
BEGIN
  PERFORM public.lock_erasure_org(p_org_id);
  IF (SELECT count(*) FROM public.sessions
      WHERE org_id = p_org_id AND kind = 'explicit' AND ended_at IS NULL) >= p_cap THEN
    RETURN;
  END IF;
  INSERT INTO public.sessions(org_id, model, kind)
    VALUES (p_org_id, p_model, 'explicit') RETURNING * INTO created;
  SELECT c.activation_id INTO covered_activation
    FROM public.erasure_org_coverage c CROSS JOIN public.erasure_deployment d
    WHERE c.org_id = p_org_id AND c.unknown_at IS NULL AND d.id AND d.enabled
      AND d.source_generation = 'managed_explicit_session_v1'
      AND c.activation_id = d.activation_id;
  IF covered_activation IS NOT NULL THEN
    INSERT INTO public.session_erasure_state(org_id, session_id, activation_id)
      VALUES (p_org_id, created.id, covered_activation);
  END IF;
  RETURN NEXT created;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_project_session_if_under_cap(
  p_org_id uuid, p_model text, p_cap integer, p_project_scope text
) RETURNS SETOF public.sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE created public.sessions%ROWTYPE; covered_activation uuid;
BEGIN
  PERFORM public.lock_erasure_org(p_org_id);
  IF (SELECT count(*) FROM public.sessions
      WHERE org_id = p_org_id AND kind = 'explicit' AND ended_at IS NULL) >= p_cap THEN
    RETURN;
  END IF;
  INSERT INTO public.sessions(org_id, model, kind, project_scope)
    VALUES (p_org_id, p_model, 'explicit', p_project_scope) RETURNING * INTO created;
  SELECT c.activation_id INTO covered_activation
    FROM public.erasure_org_coverage c CROSS JOIN public.erasure_deployment d
    WHERE c.org_id = p_org_id AND c.unknown_at IS NULL AND d.id AND d.enabled
      AND d.source_generation = 'managed_explicit_session_v1'
      AND c.activation_id = d.activation_id;
  IF covered_activation IS NOT NULL THEN
    INSERT INTO public.session_erasure_state(org_id, session_id, activation_id)
      VALUES (p_org_id, created.id, covered_activation);
  END IF;
  RETURN NEXT created;
END;
$$;

-- These triggers are invokers: a definer trigger must never use its own owner
-- as evidence that an ordinary caller is the eraser.
CREATE FUNCTION public.guard_session_erasure_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE owner_org uuid; target_id uuid; target_state text;
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF TG_OP = 'INSERT' THEN
    owner_org := NEW.org_id; target_id := NEW.id;
  ELSE
    owner_org := OLD.org_id; target_id := OLD.id;
  END IF;
  PERFORM public.lock_erasure_org(owner_org);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('erasure_session:' || target_id::text)::bigint);
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id = target_id) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'session erasure identity cannot be reused';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'session erasure identity is immutable';
  END IF;
  SELECT state INTO target_state FROM public.session_erasure_state
    WHERE session_id = target_id;
  IF TG_OP = 'DELETE' THEN
    IF target_state IS NOT NULL
      AND NOT (current_user = 'devops_erasure_executor' AND target_state = 'erasing') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'enrolled session requires managed erasure';
    END IF;
    RETURN OLD;
  END IF;
  IF target_state IN ('erasing', 'complete') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'session erasure write fence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a_session_erasure_authority
  BEFORE INSERT OR UPDATE OR DELETE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_session_erasure_authority();

CREATE FUNCTION public.guard_organization_erasure_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'organization erasure identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM public.mark_erasure_coverage_unknown(OLD.id, 'organization_deleted');
  RETURN OLD;
END;
$$;
CREATE TRIGGER a_organization_erasure_authority
  BEFORE UPDATE OF id OR DELETE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.guard_organization_erasure_authority();

-- Transfer only the named functions, then remove the temporary schema CREATE
-- capability needed for ownership transfer. Nobody gets role membership.
GRANT USAGE, CREATE ON SCHEMA public TO devops_erasure_executor;
ALTER FUNCTION public.require_erasure_read_committed() OWNER TO devops_erasure_executor;
ALTER FUNCTION public.lock_erasure_org(uuid) OWNER TO devops_erasure_executor;
ALTER FUNCTION public.create_managed_organization(text,text) OWNER TO devops_erasure_executor;
ALTER FUNCTION public.mark_erasure_coverage_unknown(uuid,text) OWNER TO devops_erasure_executor;
ALTER FUNCTION public.create_session_if_under_cap(uuid,text,integer) OWNER TO devops_erasure_executor;
ALTER FUNCTION public.create_project_session_if_under_cap(uuid,text,integer,text) OWNER TO devops_erasure_executor;
ALTER FUNCTION public.guard_session_erasure_authority() OWNER TO devops_erasure_executor;
ALTER FUNCTION public.guard_organization_erasure_authority() OWNER TO devops_erasure_executor;
REVOKE CREATE ON SCHEMA public FROM devops_erasure_executor;

REVOKE ALL ON FUNCTION public.require_erasure_read_committed(), public.lock_erasure_org(uuid),
  public.create_managed_organization(text,text), public.mark_erasure_coverage_unknown(uuid,text),
  public.create_session_if_under_cap(uuid,text,integer),
  public.create_project_session_if_under_cap(uuid,text,integer,text),
  public.guard_session_erasure_authority(), public.guard_organization_erasure_authority()
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.require_erasure_read_committed(), public.lock_erasure_org(uuid),
  public.create_managed_organization(text,text), public.mark_erasure_coverage_unknown(uuid,text),
  public.create_session_if_under_cap(uuid,text,integer),
  public.create_project_session_if_under_cap(uuid,text,integer,text),
  public.guard_session_erasure_authority(), public.guard_organization_erasure_authority()
  TO service_role;
