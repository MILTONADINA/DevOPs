-- Optional operator-bound project identity for commercial API keys.
-- Legacy keys remain unbound; a client cannot supply or change this column.
ALTER TABLE public.api_keys
  ADD COLUMN project_scope text,
  ADD CONSTRAINT api_keys_project_scope_format CHECK (
    project_scope IS NULL OR project_scope ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'
  );
