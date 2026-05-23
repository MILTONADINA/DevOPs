---
name: nextjs-server-action-safety
description: Defend against client/server boundary confusion in Next.js Server Actions. Patterns covered include authn drift in token-bound mutations, input validation at the action boundary, and mutation idempotency under retry. Triggers on Server Action authoring (functions with `use server` directive) and Next.js form-action references. OWASP ASI02 (Tool Misuse) plus ASI03 (Identity & Privilege Abuse -- authn drift) defense.
---

# Next.js Server Action Safety

> Defends against **OWASP ASI02 (Tool Misuse)** -- a Server Action invoked
> from a wrong client context (logged-out tab, different user's session, an
> attacker's CSRF-shaped payload) re-invokes the server-side mutation with
> the agent's logged-in privileges -- AND **OWASP ASI03 (Identity & Privilege
> Abuse)** -- authn drift where a token-bound mutation runs with stale or
> elevated identity because the action implicitly trusts client-passed
> context instead of re-deriving identity from the server-side session.

**Tradeoff:** Server Actions are a powerful ergonomic for mutations -- they
collapse the form-POST + route-handler + revalidation triad into one
function declaration. The cost: the function is exposed at a public URL
(Next.js compiles each action to a callable endpoint), so it must be
treated like any other public mutation entry point. Without the patterns
below, the convenience leaks into the security model.

---

## Why this matters

Server Actions look like local function calls (`await myAction(formData)`)
but they're actually HTTP POST endpoints generated at build time. Any
authenticated tab can invoke them. Any unauthenticated client can probe
the endpoint URL. Any code in the same Next.js app can import and call
them. The "server-only" annotation (`'use server'`) marks the boundary --
it does NOT add authentication, authorization, validation, or rate
limiting.

A handler that doesn't explicitly re-verify identity, validate input, and
guard against replay is structurally identical to an unauthenticated POST
endpoint. The familiar function-call surface hides this fact from authors
who haven't shipped Next.js mutations in production.

---

## Pattern 1 -- Re-derive identity from server-side session inside every action

Inside the action, ALWAYS read the session from a server-side source
(cookie-backed session store, `auth()` helper, JWT verified against your
own signing secret). Never trust an `actorId` / `userId` / `tenantId`
passed as a form field or function argument -- it's attacker-controllable.

```ts
'use server';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { z } from 'zod';

const UpdateProfileInput = z.object({
  displayName: z.string().min(1).max(120),
  bio: z.string().max(2000).optional(),
});

export async function updateProfile(formData: FormData) {
  // 1. Re-derive identity. session.userId is the server-side truth.
  const session = await auth();
  if (!session?.userId) {
    throw new Error('unauthenticated');
  }

  // 2. Validate input at the boundary -- the function signature accepts
  //    FormData (any shape); Zod is the runtime contract.
  const parsed = UpdateProfileInput.safeParse({
    displayName: formData.get('displayName'),
    bio: formData.get('bio'),
  });
  if (!parsed.success) {
    throw new Error('invalid input');
  }

  // 3. Scope the mutation to the session-derived identity, not any
  //    client-passed identifier. db.user.update WHERE id = session.userId.
  await db.user.update({
    where: { id: session.userId },
    data: parsed.data,
  });
}
```

A defender reviewing this action can answer in one minute: "Who is this
mutation acting on?" The answer is "the server-derived session user, not
whoever the client says they are."

---

## Pattern 2 -- Validate input with a runtime schema at the action boundary

TypeScript types are compile-time only. The `FormData` argument is the
real runtime contract -- it's whatever the client posted, which may be
arbitrary strings, arrays, or absent fields.

Use Zod / Valibot / a similar runtime validator. Validate at the first
line of the action body. Reject invalid input with a generic error
message (don't echo the invalid value back -- it's potentially attacker-
controlled and may be reflected somewhere).

The validator's schema is also documentation: a defender can read it and
know exactly which fields the action accepts and what the bounds are.

---

## Pattern 3 -- Idempotency for mutations that the client may retry

Server Actions are invoked from forms and from optimistic-UI patterns,
both of which can retry on transient failure (network blip, slow render,
user double-clicks Submit). A mutation that books a flight, charges a
card, or sends a message has to handle the retry without producing two
side effects.

The universal pattern: an idempotency key passed through the action and
checked against a dedupe store. The Stripe-style approach works here too:

```ts
'use server';

export async function chargeOrder(formData: FormData) {
  const session = await auth();
  if (!session?.userId) throw new Error('unauthenticated');

  const idempotencyKey = formData.get('idempotency_key')?.toString();
  if (!idempotencyKey) throw new Error('missing idempotency key');

  // Dedupe via Redis SETNX (see security/webhook-idempotency for the
  // full storage-strategy tradeoff). Same pattern, different surface.
  const claimed = await redis.set(
    `action:chargeOrder:${session.userId}:${idempotencyKey}`,
    'processing',
    { NX: true, EX: 3600 },
  );
  if (claimed !== 'OK') {
    return { status: 'duplicate (idempotent)' };
  }

  // ... perform the charge ...
}
```

For forms, generate the idempotency key on first render (client-side
`crypto.randomUUID()`) and persist it through retry attempts on the same
form instance.

---

## Anti-patterns

The following patterns SHALL NOT appear in production Server Actions. Each
fails for the reason given.

### Anti-pattern 1 -- Trusting client-passed actor identity

```ts
// WRONG
export async function deletePost(formData: FormData) {
  'use server';
  const userId = formData.get('userId');  // attacker-controlled!
  await db.post.delete({ where: { authorId: userId } });
}
```

Any client can post any `userId`. The action runs with whatever
elevated DB privileges the server holds; the attacker just specified
WHICH user's posts to delete. ASI03 (Identity & Privilege Abuse) by way
of authn drift.

### Anti-pattern 2 -- No runtime input validation

```ts
// WRONG
export async function updatePrice(formData: FormData) {
  'use server';
  const price = formData.get('price');  // could be "FREE", "-1", "1e100"
  await db.product.update({ where: { id: ... }, data: { price } });
}
```

`FormData.get` returns `string | File | null`. Without Zod (or equivalent)
the action accepts any string. The mutation can be coerced into negative
prices, NaN, infinity, SQL-injection-shaped strings, or other unexpected
values. The TypeScript signature `formData: FormData` says nothing about
what's actually inside.

### Anti-pattern 3 -- No idempotency on optimistic-UI retry surfaces

```ts
// WRONG
export async function placeOrder(formData: FormData) {
  'use server';
  const session = await auth();
  await db.order.create({ data: { userId: session.userId, ... } });
  // No retry guard. User double-clicks; two orders created.
}
```

The double-submit pattern produces two `db.order.create` calls with no
way to detect the duplicate at the receiver. Always pair mutations that
have visible side effects (orders, charges, messages, deploys) with an
idempotency-key check.

---

## Where the patterns fall short

These patterns assume a *server-trusted* session source (cookie-backed
session store, JWT verified server-side). They do not protect against:

- Session-token theft (XSS exfiltrating the cookie, browser-history
  leak). Defend at the session-store layer (HttpOnly + Secure +
  SameSite=Strict cookies).
- A compromised database user that bypasses the application layer
  entirely. Defend at the DB-policy layer (Postgres RLS, Supabase
  RLS -- see the `stack-specific/supabase/rls-policies` skill).
- Cross-Site Request Forgery from same-site contexts that share the
  user's cookie. Next.js Server Actions DO include built-in CSRF
  protection (same-origin policy on the generated POST endpoints), but
  verify your Next.js version's specifics; older 13.x branches had
  partial coverage.

This skill teaches the application-layer discipline; defense in depth
layers below it.

---

## ASI/AST mapping

This skill addresses two canonical OWASP ASI 2026 categories from
`governance/owasp-asi-2026/threats.md`:

- **ASI02 (Tool Misuse)** -- a Server Action invoked outside its
  intended use context (logged-out tab, wrong tenant, CSRF-shaped
  request) re-invokes the underlying mutation with the agent layer's
  legitimate privileges. Treating Server Actions as public POST
  endpoints and requiring per-action input validation + identity
  re-derivation closes the misuse path.
- **ASI03 (Identity & Privilege Abuse)** -- authn drift where the
  action trusts client-passed identity (a `userId` form field, a
  `tenantId` header) instead of re-deriving from server-side session.
  Pattern 1 (re-derive identity) is the load-bearing defense.

---

## Testing

For each Server Action, write at least three tests:

```ts
test('rejects unauthenticated invocation', async () => {
  // Call action with no session cookie. Expect throw.
});

test('rejects malformed input', async () => {
  // Call action with FormData missing required fields or wrong types.
});

test('idempotent on duplicate idempotency key', async () => {
  // Call action twice with same key. Expect second call to no-op.
});
```

A skill is working when production incident reports stop mentioning
"action ran twice from double-click", "user X's post deleted by user Y",
"price set to -1 via crafted form submit".

---

## See also

- `governance/owasp-asi-2026/threats.md` -- ASI02 + ASI03 full text
- `skills/universal/security/webhook-idempotency/SKILL.md` -- the
  universal webhook-idempotency skill; Server Actions are a parallel
  retry-prone surface that benefits from the same dedupe-store
  discipline.
- `skills/stack-specific/nextjs/check-route-types/SKILL.md` -- the
  complementary type-hygiene skill for Next.js route handlers.
