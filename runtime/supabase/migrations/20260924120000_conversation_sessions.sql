-- Server-owned commercial conversations are scoped to the authenticating key.
ALTER TABLE public.sessions DROP CONSTRAINT sessions_kind_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_kind_check
  CHECK (kind IN ('explicit', 'usage', 'memory', 'conversation'));

ALTER TABLE public.sessions ADD COLUMN conversation_key_id uuid;
CREATE UNIQUE INDEX api_keys_id_org_unique ON public.api_keys (id, org_id);
ALTER TABLE public.sessions ADD CONSTRAINT conversation_key_org_fk
  FOREIGN KEY (conversation_key_id, org_id) REFERENCES public.api_keys (id, org_id);
ALTER TABLE public.sessions ADD CONSTRAINT conversation_key_kind_check
  CHECK ((kind = 'conversation' AND conversation_key_id IS NOT NULL) OR
         (kind <> 'conversation' AND conversation_key_id IS NULL));
CREATE INDEX sessions_conversation_key_idx ON public.sessions (org_id, conversation_key_id, id)
  WHERE kind = 'conversation' AND ended_at IS NULL;

CREATE FUNCTION public.conversation_key_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_key_id IS DISTINCT FROM OLD.conversation_key_id OR
     NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'conversation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_key_immutable
  BEFORE UPDATE OF conversation_key_id, org_id, kind ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.conversation_key_immutable();
