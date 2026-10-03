# Vercel deployment — historical adapter

The Vercel function adapter remains in `vercel-src/entry.ts` for historical and
personal-mode use. The paid Supabase project used by the earlier deployment is
retired. The old `/tmp` capture directory is ephemeral, and Vercel has no
persistent project-local usage outbox. Team-mode startup therefore fails closed
on Vercel even though C2 usage persistence no longer needs a signing secret.

Team-mode usage requires a persistent host, the local PostgreSQL stack
(or a future supported persistent database), and a durable volume for
`runtime/data/usage-outbox/`. See [COMMERCIAL_ONBOARDING.md](COMMERCIAL_ONBOARDING.md)
for the current local startup path. A public deployment needs fresh operational
verification before design-partner use.
