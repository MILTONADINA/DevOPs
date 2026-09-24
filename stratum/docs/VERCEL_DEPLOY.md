# Vercel deployment — historical adapter, not a commercial billing target

The Vercel function adapter remains in `vercel-src/entry.ts` for historical and
personal-mode use. The paid Supabase project used by the earlier deployment is
retired. The old `/tmp` capture directory is ephemeral, and Vercel has no
persistent project-local usage outbox. Commercial startup with
`CQ_BILLING_SIGNING_SECRET` therefore fails closed on Vercel.

Commercial billing now requires a persistent host, the local PostgreSQL stack
(or a future supported persistent database), and a durable volume for
`stratum/data/usage-outbox/`. See [COMMERCIAL_ONBOARDING.md](COMMERCIAL_ONBOARDING.md)
for the current local startup path. A public deployment needs fresh operational
verification before design-partner use.
