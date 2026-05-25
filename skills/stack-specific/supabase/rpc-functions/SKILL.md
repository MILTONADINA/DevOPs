---
name: supabase-rpc-functions
description: Supabase RPC function security patterns -- SECURITY DEFINER with `SET search_path` discipline, `REVOKE EXECUTE FROM public` for least-privilege exposure, JSON-arg shape drift between client and server contracts. Triggers on Supabase RPC function authoring (`CREATE OR REPLACE FUNCTION`, `rpc(` client calls). OWASP ASI02 (Tool Misuse) defense -- RPCs that bypass RLS are a privileged-backdoor path.
---

# Supabase RPC Functions

> Defends against **OWASP ASI02 (Tool Misuse)** -- specifically, the
> case where a Supabase RPC function with `SECURITY DEFINER` privileges
> becomes a privileged backdoor that bypasses the row-level security
> policies the application otherwise relies on. Supabase exposes any
> Postgres function in the `public` schema as an HTTP RPC endpoint via
> PostgREST; that exposure surface is BROADER than most authors
> appreciate. Without careful authoring, an RPC intended for internal
> server-side use becomes callable by any authenticated client.

**Tradeoff:** RPC functions are powerful for encapsulating multi-step
operations as atomic Postgres transactions. The cost: every
`SECURITY DEFINER` function is a privilege-escalation gateway whose
inputs and authorization must be explicitly defended. RLS protects
tables; RPCs sit outside RLS unless authored carefully.

---

## Why this matters

PostgREST's default behavior:

- Every function in the `public` schema is exposed as an HTTP endpoint.
- Functions inherit the caller's role unless declared `SECURITY DEFINER`.
- `SECURITY DEFINER` functions run with the function-creator's
  privileges, which means an `auth.uid()`-aware function written by
  a superuser-equivalent admin executes WITH ADMIN PRIVILEGES even
  when called by an anonymous user.
- `search_path` for `SECURITY DEFINER` functions is the calling
  session's `search_path` by default -- a malicious client can prepend
  a schema they control, hijacking unqualified table references inside
  the function body.

The combination "exposed by default + privileged execution + caller-
controlled search_path" is the canonical Postgres RPC vulnerability
class. The patterns below close each piece.

---

## Pattern 1 -- `SECURITY DEFINER` with explicit `SET search_path`

When a function MUST run with creator privileges (typical case:
crossing a security boundary like updating a counter on behalf of a
user who can read but not directly modify the table), declare
`SECURITY DEFINER` AND pin the `search_path`:

```sql
CREATE OR REPLACE FUNCTION public.increment_post_view_count(p_post_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- All table references are now resolved against public + pg_temp,
  -- regardless of what the caller's session search_path is.
  UPDATE public.posts
    SET view_count = view_count + 1
    WHERE id = p_post_id;
END;
$$;
```

`SET search_path = public, pg_temp` pins the schema resolution at
function-definition time. `pg_temp` last is the canonical safe pattern --
temporary objects the caller might create can't shadow the public
schema's tables.

A function declared `SECURITY DEFINER` WITHOUT `SET search_path` is a
critical defect.

---

## Pattern 2 -- `REVOKE EXECUTE FROM public` after creating the function

PostgreSQL grants `EXECUTE` on functions to `PUBLIC` (every role) by
default. For any function that should be invokable only by specific
roles or only by authenticated users:

```sql
-- Create the function.
CREATE OR REPLACE FUNCTION public.admin_grant_role(p_user_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ ... $$;

-- Immediately revoke the public default.
REVOKE EXECUTE ON FUNCTION public.admin_grant_role(uuid, text) FROM public;

-- Grant only to the role(s) that should call it.
GRANT EXECUTE ON FUNCTION public.admin_grant_role(uuid, text) TO authenticated;

-- Or, for service-role-only functions:
GRANT EXECUTE ON FUNCTION public.admin_grant_role(uuid, text) TO service_role;
```

The `REVOKE ... FROM public` is the load-bearing step. Without it, the
`anon` role (unauthenticated users) can call the function. PostgREST
exposes the endpoint; clients hit it; the SECURITY DEFINER body runs
with admin privileges on behalf of an unauthenticated attacker.

---

## Pattern 3 -- Defensive JSON-arg parsing for RPCs accepting JSONB

RPCs that accept a JSONB argument must parse the JSON defensively
inside the function body. A client can pass any shape; the function's
parameter type is just `jsonb`, not a struct contract.

```sql
CREATE OR REPLACE FUNCTION public.bulk_update_settings(p_settings jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_theme text;
  v_locale text;
BEGIN
  -- Extract with type assertion; ->> returns text or NULL.
  v_theme := p_settings ->> 'theme';
  v_locale := p_settings ->> 'locale';

  -- Validate inside the function body. The caller can pass any JSON
  -- shape; the function decides what to accept.
  IF v_theme IS NOT NULL AND v_theme NOT IN ('light', 'dark', 'auto') THEN
    RAISE EXCEPTION 'invalid theme: %', v_theme;
  END IF;
  IF v_locale IS NOT NULL AND length(v_locale) > 10 THEN
    RAISE EXCEPTION 'locale too long';
  END IF;

  -- Use auth.uid() to scope the update to the calling user. SECURITY
  -- DEFINER runs with elevated DB privileges, but auth.uid() still
  -- returns the JWT subject of the actual caller.
  UPDATE public.user_settings
    SET theme = COALESCE(v_theme, theme),
        locale = COALESCE(v_locale, locale)
    WHERE user_id = auth.uid();
END;
$$;
```

The COALESCE pattern handles partial updates: only fields present in
the JSON are updated. Critically, the scope is `WHERE user_id =
auth.uid()` -- the SECURITY DEFINER's elevated privileges don't grant
the right to update OTHER users' settings; the function's own WHERE
clause restricts that.

---

## Anti-patterns

### Anti-pattern 1 -- `SECURITY DEFINER` without `SET search_path`

```sql
-- WRONG
CREATE OR REPLACE FUNCTION public.grant_admin(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER  -- no SET search_path!
AS $$
BEGIN
  UPDATE users SET role = 'admin' WHERE id = p_user;  -- which 'users'?
END;
$$;
```

A caller can `SET search_path = malicious_schema, public;` before
invoking the function. Inside the function body, `users` resolves to
`malicious_schema.users` (a table the attacker controls). The
`UPDATE` runs against the wrong table with admin privileges. Always
pin `search_path` for SECURITY DEFINER functions.

### Anti-pattern 2 -- Forgetting `REVOKE EXECUTE FROM public`

```sql
-- WRONG: anon role can call this and run with admin privileges
CREATE OR REPLACE FUNCTION public.elevated_helper(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ /* does something privileged */ $$;
-- (no REVOKE)
```

The default `EXECUTE TO public` grant means PostgREST exposes the
function for anonymous callers. Test it: hit
`https://<project>.supabase.co/rest/v1/rpc/elevated_helper` with only
the anon key. If you get a 200, the function is publicly callable. The
REVOKE + targeted GRANT pattern is mandatory.

### Anti-pattern 3 -- Trusting JSONB arg shape without validation

```sql
-- WRONG
CREATE OR REPLACE FUNCTION public.bulk_action(p_args jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  EXECUTE 'UPDATE posts SET ' || (p_args ->> 'set_clause') || ' WHERE id = ' || (p_args ->> 'id');
END;
$$;
```

This is a SQL-injection RPC. The caller's JSON `set_clause` is
concatenated directly into the SQL string. Even a non-malicious client
that passes `set_clause: "title = NULL"` produces an unexpected
update; a malicious client passes
`set_clause: "title = NULL; DROP TABLE users; --"` and the EXECUTE
runs the destructive statement.

NEVER concatenate user-controlled input into dynamic SQL. Use
parameterised queries, plpgsql's typed local variables, or the
`format(...)` function with `%I` (identifier) / `%L` (literal) format
specifiers if dynamic SQL is genuinely required.

---

## ASI/AST mapping

This skill addresses **canonical OWASP ASI02 (Tool Misuse)** from
`governance/owasp-asi-2026/threats.md`. Supabase RPC functions ARE
tools in the agentic sense -- they're invokable HTTP endpoints with
side effects. A SECURITY DEFINER function callable by anonymous users
with an unpinned search_path is a tool whose misuse is trivial. The
patterns above ensure RPC tools are invokable only by intended callers,
run in a hardened execution environment (pinned search_path), and
validate their JSON input.

The complementary RLS skill
(`stack-specific/supabase/rls-policies`) is the ASI03 (Identity &
Privilege Abuse) counterpart for the same Supabase integration. Both
skills together close the database-layer authz surface; missing either
leaves a gap.

---

## Testing

For every RPC function, write integration tests that exercise:

```sql
-- 1. Anon-role caller cannot invoke (after REVOKE):
SET ROLE anon;
SELECT public.elevated_helper('some-uuid');  -- expect permission denied

-- 2. Authenticated-role caller can invoke:
SET ROLE authenticated;
SET request.jwt.claim.sub = 'user-a-uuid';
SELECT public.bulk_update_settings('{"theme": "dark"}'::jsonb);  -- expect success

-- 3. Malformed JSON arg is rejected:
SELECT public.bulk_update_settings('{"theme": "purple"}'::jsonb);  -- expect raised exception
```

A test that misses any of these three is incomplete. Wire them into
the same pytest/pgTAP harness that tests RLS policies.

---

## See also

- `governance/owasp-asi-2026/threats.md` -- ASI02 full text
- Supabase RPC guide:
  https://supabase.com/docs/guides/database/functions
- `skills/stack-specific/supabase/rls-policies/SKILL.md` -- the
  ASI03 companion skill for the same Supabase integration
- PostgreSQL SECURITY DEFINER docs:
  https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY
