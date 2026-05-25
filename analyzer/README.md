# Project Analyzer

Scans a project on first run and produces a recommendation for which DevOPs
components to install: skills, hooks, subagents, MCP servers, mode default,
and lifecycle phase.

## How it works

```
analyzer/scan.ts        ← detects stack, domain, state, risk;
                          maps detection → recommendation inline
       │
       ▼
analyzer/install.ts     ← installs the chosen components
                          (Phase 2 / Area F adds signature verification
                          before copy; see docs/SKILL_SIGNING.md)
```

Recommendation logic lives directly in `scan.ts` via inline conditionals
(the original `recommend.ts` split described in early drafts was not
implemented — Phase 2 sessions A.06, D.12, G.08 settled on the inline
pattern as the canonical approach).

## What it detects

### Stack
- Package managers: npm, pnpm, yarn, pip, poetry, uv, cargo, go, gem
- Frameworks: Next.js, Remix, Astro, FastAPI, Django, Flask, Rails, Phoenix,
  Axum, Actix, Hono, Express, Fastify, NestJS, etc.
- Database: Postgres, MySQL, SQLite, Mongo, Redis, Supabase, Neon, PlanetScale
- ORM: Prisma, Drizzle, SQLAlchemy, ActiveRecord, sqlx, Diesel
- Deploy: Vercel, Netlify, Fly, Railway, Render, AWS, GCP, Cloudflare
- Auth: NextAuth, Clerk, Supabase Auth, Auth0, custom

### Domain
- E-commerce / payments
- Children's services (COPPA scope)
- Healthcare (HIPAA scope)
- Financial (PCI scope)
- Internal tooling
- Public API
- Mobile app
- Marketing site

### State
- Greenfield (no git history)
- Brownfield (existing code; default safest mode)
- Migration (parallel old/new code paths)
- Hotfix (recent open production incident)
- Audit (read-only)

### Risk profile
- Has secrets in repo? (gitleaks scan)
- Has open vulnerabilities? (pnpm audit / safety / cargo audit)
- WCAG findings? (axe scan)
- Recent prod incidents? (look in docs/incidents/)
- Compliance scope from `.workflow/client/profile.yml`

## What it recommends

For each detection, the analyzer suggests:
- Tier 3 skills to install (stack-specific)
- Tier 3 hooks (e.g., schema-migration safety for projects with Prisma)
- MCP servers (Playwright for full-stack, Stripe MCP for e-commerce, etc.)
- Subagent specializations
- Initial mode (greenfield / brownfield / etc.)
- Initial lifecycle phase

## Run

```bash
./scripts/analyze.sh
```

Produces `.workflow/profile.yml` and a human-readable
`.workflow/recommendations.md` for user review.

After user approval:

```bash
./scripts/init-project.sh
```

Installs the recommended components and wires the universal hooks into the
project.
