---
name: supabase-rls-policies
description: Supabase Row-Level Security policy patterns and failure modes -- policy bypass via service-role key in client code, USING-vs-WITH-CHECK confusion, missing INSERT policies that leave write paths unprotected. References GDPR Article 32 (Security of processing) and SOC 2 Trust Services Criteria CC6.1 (Logical and Physical Access Controls) for the least-privilege alignment. Triggers on Supabase table policy authoring (`CREATE POLICY`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` references). OWASP ASI03 (Identity & Privilege Abuse) defense.
---

# Supabase Row-Level Security Policies

> Defends against **OWASP ASI03 (Identity & Privilege Abuse)** in
> Supabase-backed applications by enforcing least-privilege at the
> Postgres row level. Supabase's auth model produces a JWT carrying the
> authenticated user's UUID; PostgREST (Supabase's API layer) propagates
> that JWT into the `auth.uid()` function inside the database, which
> RLS policies use to scope queries. Done right, the database refuses
> to return rows the user shouldn't see -- even if the application
> layer has a bug. Done wrong, RLS is a false sense of security: the
> service-role key bypasses RLS entirely, missing policies leave gaps,
> and USING-vs-WITH-CHECK confusion ships read-only-looking restrictions
> that allow writes.

**Tradeoff:** Per-row policy enforcement adds Postgres planner overhead
and shifts authorization logic from the application layer into SQL
policies. Worth it: RLS is the database-layer expression of
least-privilege that keeps working when the application is compromised,
when a service-role-key bypass leaks, or when a future code path
forgets to apply the equivalent application-layer check.

## Why this matters

RLS aligns with **GDPR Article 32 (Security of Processing)** --
specifically the "appropriate technical and organisational measures to
ensure a level of security appropriate to the risk" obligation -- and
**SOC 2 Trust Services Criterion CC6.1 (Logical and Physical Access
Controls)** -- "the entity implements logical access security
software, infrastructure, and architectures over protected information
assets." Postgres RLS is the canonical defense-in-depth layer for both
controls: even if the application is compromised, the database enforces
row-level authorization for any identity-scoped data.

---

## Pattern 1 -- Enable RLS on every table holding user-scoped data

The first move on any table that holds PII, financial data, tenant-
scoped records, or anything else identity-bound:

```sql
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
```

After enabling, the table is INACCESSIBLE to non-superusers until at
least one policy is created. That's the safe default. Adding the
`ENABLE ROW LEVEL SECURITY` without immediately authoring policies is
acceptable -- it fails closed.

For every policy you author, document the threat model in a comment
above the SQL: who is this policy for, what access does it grant, why
is the scoping safe?

---

## Pattern 2 -- Authoring policies with USING (read) and WITH CHECK (write)

The two clauses serve different roles:

- **USING** -- filters rows VISIBLE to the operation (applies to
  SELECT, UPDATE, DELETE).
- **WITH CHECK** -- validates rows being WRITTEN by the operation
  (applies to INSERT, UPDATE).

For SELECT-only policies, only USING applies. For INSERT-only policies,
only WITH CHECK applies. For UPDATE, BOTH apply -- USING filters which
rows the user can attempt to update (the row must be visible to be
modified), and WITH CHECK validates the row's post-update state.

```sql
-- Read your own posts.
CREATE POLICY "select_own_posts"
ON public.posts
FOR SELECT
USING (author_id = auth.uid());

-- Insert posts where you are the author.
CREATE POLICY "insert_own_posts"
ON public.posts
FOR INSERT
WITH CHECK (author_id = auth.uid());

-- Update your own posts, and ensure you're still the author after the update.
CREATE POLICY "update_own_posts"
ON public.posts
FOR UPDATE
USING (author_id = auth.uid())
WITH CHECK (author_id = auth.uid());

-- Delete your own posts.
CREATE POLICY "delete_own_posts"
ON public.posts
FOR DELETE
USING (author_id = auth.uid());
```

Per-operation policies are clearer than `FOR ALL` policies because
each operation's intent is reviewable in isolation. A new contributor
modifying one operation's authz can't accidentally widen authz on
other operations.

---

## Pattern 3 -- Service-role-key usage is server-side only, never shipped to clients

Supabase issues two API keys:

- **Anon key** (`sb_publishable_*` or older `eyJ...` JWT with role `anon`) --
  safe to ship in client code. Subject to RLS.
- **Service-role key** (`sb_secret_*` or older `eyJ...` JWT with role
  `service_role`) -- **BYPASSES RLS ENTIRELY**. Anything done with this
  key has full database authority.

The service-role key belongs in server-side environment variables only.
It lives in the vault (1Password / AWS Secrets Manager / Doppler), is
loaded at server boot, and never reaches a Next.js / React / Vue
client bundle. The `NEXT_PUBLIC_SUPABASE_*` env-var naming convention
(`NEXT_PUBLIC_*` is shipped to the browser by Next.js) is exactly the
naming you must NOT use for the service-role key.

Discipline:

```bash
# .env.local (developer machine -- gitignored, not shipped)
SUPABASE_SERVICE_ROLE_KEY=sb_secret_AbCdEf...   # NEVER NEXT_PUBLIC_
NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
```

A grep of the client bundle for `sb_secret_` should return zero
results. Wire that grep into CI for safety:

```bash
grep -r "sb_secret_" .next/ public/ && exit 1 || exit 0
```

---

## Anti-patterns

### Anti-pattern 1 -- Service-role-key bypass shipped to client code

```ts
// WRONG (in client-side code shipped to the browser)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,  // exposes ALL data!
);
```

`NEXT_PUBLIC_*` ships in the browser bundle. The service-role key
bypasses RLS, so this client has full database authority. Every user
of the application can read every row in every table. RLS is
fully defeated.

Use the anon key in clients (`NEXT_PUBLIC_SUPABASE_ANON_KEY`). Reserve
the service-role key for server-side code, ideally in a thin API layer
that enforces explicit authorization checks before invoking
service-role queries.

### Anti-pattern 2 -- USING without WITH CHECK on UPDATE policies

```sql
-- WRONG
CREATE POLICY "update_own_posts"
ON public.posts
FOR UPDATE
USING (author_id = auth.uid());
-- No WITH CHECK!
```

USING filters which rows the user can attempt to update. WITH CHECK
validates the post-update state. Without WITH CHECK, the user can
update their own post AND in the same update set `author_id` to
someone else's UUID, effectively transferring ownership of the post
(or stealing someone else's post by updating its other fields after
the ownership transfer). Always pair USING with WITH CHECK on UPDATE,
typically with the same predicate.

### Anti-pattern 3 -- Missing INSERT policy after enabling RLS

```sql
-- WRONG: RLS enabled, SELECT policy authored, but no INSERT policy.
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_posts"
ON public.posts
FOR SELECT USING (author_id = auth.uid());

-- INSERT policy missing -- table is now INSERT-blocked for everyone
-- except the service-role key. Production write traffic fails.
```

A common deployment foot-gun: enable RLS, author a SELECT policy, ship
to staging, discover that no one can write to the table. The reverse
direction is worse: in development with the service-role key (which
bypasses RLS), inserts succeed; in production where the application
uses the anon key with a per-user JWT, inserts fail because no INSERT
policy authorizes them.

Always author INSERT, UPDATE, DELETE policies alongside SELECT if the
table needs writes from non-service-role identities.

---

## ASI/AST mapping

This skill addresses **canonical OWASP ASI03 (Identity & Privilege
Abuse)** from `governance/owasp-asi-2026/threats.md`. RLS is the
database-layer expression of least-privilege per user identity; the
patterns above ensure that the application's auth.uid() propagation
into RLS policies actually scopes data correctly, and the
anti-patterns enumerate the common ways that scoping leaks.

Compliance alignment:

- **GDPR Article 32 (Security of processing)** -- "appropriate
  technical and organisational measures." Per-user RLS is canonical.
- **SOC 2 TSC CC6.1 (Logical and Physical Access Controls)** --
  "implements logical access security software... over protected
  information assets." RLS is exactly this control at the database
  tier.

These citations are at the article / criterion level which has been
stable across recent revisions of both standards. Operators verifying
against current text should reference the latest GDPR consolidated
version (eur-lex.europa.eu) and the current SOC 2 TSP-100 framework.

---

## Testing

For every table with RLS enabled, write integration tests that exercise
both authorized and unauthorized access:

```sql
-- Connect as user A's JWT and INSERT a post.
SET request.jwt.claim.sub = 'user-a-uuid';
INSERT INTO posts (author_id, body) VALUES ('user-a-uuid', 'hello');

-- Connect as user B's JWT and SELECT all posts -- should see ZERO of A's posts.
SET request.jwt.claim.sub = 'user-b-uuid';
SELECT count(*) FROM posts;  -- expect 0

-- User B attempts to update A's post -- should fail (USING filters it out).
UPDATE posts SET body = 'compromised' WHERE author_id = 'user-a-uuid';
-- 0 rows affected
```

Supabase's pgTAP testing framework or a custom pytest harness with
`supabase-py` are both viable. The minimum bar: each table has
positive (authorized identity can do the operation) and negative
(unauthorized identity cannot) tests per supported operation.

---

## See also

- `governance/owasp-asi-2026/threats.md` -- ASI03 full text
- Supabase RLS guide:
  https://supabase.com/docs/guides/database/postgres/row-level-security
- `skills/stack-specific/supabase/rpc-functions/SKILL.md` -- the RPC
  companion skill (`SECURITY DEFINER` functions can bypass RLS; the
  RPC skill covers that surface)
- GDPR Article 32: https://gdpr-info.eu/art-32-gdpr/
- SOC 2 TSC framework: https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2
