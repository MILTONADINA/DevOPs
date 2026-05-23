---
name: nextjs-check-route-types
description: Type-system hygiene for Next.js App Router routes -- `any`-typed params, missing route handler signatures, generated-types staleness from `next dev` and `next build` typecheck gaps. Triggers on Next.js route handler authoring (`app/**/route.ts`, `app/**/page.tsx` typed-segments). Not agent-specific security; complementary to runtime hardening.
---

# Next.js Route Type Checking

> This skill addresses **type-system correctness**, not agent-specific
> security. The patterns here close compile-time blind spots that allow
> runtime bugs and complicate review; they are NOT the load-bearing
> defense against any OWASP ASI / AST threat. The runtime hardening of
> route handlers is the responsibility of
> `skills/stack-specific/nextjs/server-action-safety/SKILL.md` and the
> universal `security/prompt-injection-defense` skill.

**Tradeoff:** Stricter route typing catches a class of integration bugs
at build time rather than at request time. Cost: per-PR friction when
Next.js's generated types (`.next/types/...`) lag behind route file
changes during local development.

---

## Why this matters

Next.js App Router generates `RouteHandlerConfig` types at build time
based on the file system shape (`app/posts/[slug]/route.ts` produces a
typed `{ params: { slug: string } }` argument). When those generated
types are stale (e.g., a new dynamic segment added but `next dev` hasn't
re-generated), the handler signature reverts to a permissive default and
runtime arguments flow through unchecked. Reviewers see "the types pass"
without realizing the types are vacuous.

This is a footgun across the entire surface area:

- `app/api/**/route.ts` handlers with implicit-`any` parameters.
- `app/[slug]/page.tsx` route segments with un-narrowed param types.
- `searchParams` accessed without runtime validation.
- Middleware (`middleware.ts`) reading headers without typing them.

None of these are security failures on their own. They're conditions
under which a separate runtime-validation gap (the actual security
control) hides because the type checker isn't complaining.

---

## Pattern 1 -- Always type route handler signatures explicitly

The compile-time signature for an App Router handler:

```ts
// app/api/posts/[slug]/route.ts
import { NextRequest, NextResponse } from 'next/server';

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const { slug } = await context.params;
  // ... handler body ...
  return NextResponse.json({ slug });
}
```

Explicit `NextRequest` (NOT bare `Request`) gives access to Next.js-
specific fields (`request.nextUrl`, `request.cookies`). Explicit
`RouteContext` ties the handler's expected dynamic segments to the file
path; a renamed segment that doesn't match `slug` is a compile error.

Note Next.js 15+ awaits `params` as a Promise. Older code with sync
params won't compile against newer Next.js without migration.

---

## Pattern 2 -- Validate `searchParams` at the route boundary

```ts
import { z } from 'zod';

const SearchSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(200).optional(),
});

export async function GET(request: NextRequest) {
  const parsed = SearchSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  }
  const { page, perPage, q } = parsed.data;
  // ... use typed values, NOT raw searchParams ...
}
```

`searchParams` is `URLSearchParams`. Its `.get()` returns `string | null`;
there's no compile-time guarantee that the query string contains what
the handler assumes. Runtime validation closes the gap.

---

## Pattern 3 -- Regenerate types on dynamic-segment renames

When you rename `app/posts/[slug]/route.ts` to `app/posts/[postId]/route.ts`,
the next `next build` (or `next dev` HMR refresh) regenerates the
RouteContext types with the new param name. UNTIL that happens, the
handler still compiles against the old generated types.

Discipline: after any file-system rename inside `app/`, run
`next build --no-lint` (or stop and restart `next dev`) to force a
type-generation refresh BEFORE committing. CI's `tsc --noEmit` will
catch the drift, but local commits should not depend on CI as the
first signal.

---

## Anti-patterns

### Anti-pattern 1 -- `any`-typed handler params

```ts
// WRONG
export async function GET(request, context: any) {
  const slug = context.params.slug;  // no type narrowing
  // ...
}
```

`any` defeats the entire type system. A renamed segment, a missing
param, a wrong-shaped context object all flow through silently. Always
type both `request` and `context` explicitly.

### Anti-pattern 2 -- Trusting raw `searchParams.get()` without validation

```ts
// WRONG
export async function GET(request: NextRequest) {
  const page = request.nextUrl.searchParams.get('page');  // string | null
  const offset = parseInt(page) * 20;  // NaN if page missing
  // ...
}
```

`parseInt(null)` is `NaN`. The handler computes a `NaN` offset and
silently returns whatever the DB does with that. Runtime validation
(Pattern 2) is the fix.

### Anti-pattern 3 -- Generated-types staleness ignored across deploys

```ts
// WRONG: file renamed from [slug] to [postId] but the handler still reads
// context.params.slug because the generated types haven't refreshed.
type RouteContext = { params: Promise<{ slug: string }> };  // STALE
```

The handler compiles locally because the old `.next/types/*` cache still
defines `slug`. On a fresh CI build (clean `.next/`), the types
regenerate to `{ postId: string }` and the handler fails compile. Or
worse: the handler ships, runtime accesses `params.slug` which is now
`undefined`, and silent NaN / null-deref bugs follow.

---

## ASI/AST mapping

**No canonical ASI/AST applies** -- type-system hygiene is general
software-correctness discipline, not an agent-specific threat surface.
The runtime-validation gaps these patterns close are protected at a
different layer (the runtime input-validation patterns in
`stack-specific/nextjs/server-action-safety` and the universal
`security/prompt-injection-defense`); this skill is the compile-time
counterpart that prevents the runtime gaps from going unnoticed in
review.

Skills that DO cover the runtime side of route safety:

- `skills/stack-specific/nextjs/server-action-safety/SKILL.md` --
  ASI02 + ASI03 for Server Actions
- `skills/universal/security/prompt-injection-defense/SKILL.md` --
  ASI01 + ASI04 for content entering the handler

---

## When this skill is working

- `tsc --noEmit` passes cleanly in CI on every PR, no `any`-typed route
  handlers in the diff.
- Route-segment renames are paired with type-regeneration in the same
  commit.
- `searchParams` access goes through a Zod (or equivalent) parser at the
  handler boundary.

---

## See also

- Next.js App Router docs on TypeScript: https://nextjs.org/docs/app/api-reference/config/typescript
- `skills/stack-specific/nextjs/server-action-safety/SKILL.md` --
  runtime-validation counterpart
