---
name: nextjs-server-action-safety
description: Defend against client/server boundary confusion in Next.js Server Actions. Patterns covered include authn drift in token-bound mutations, input validation at the action boundary, and mutation idempotency under retry. Triggers on Server Action authoring (functions with `use server` directive) and Next.js form-action references. OWASP ASI02 (Tool Misuse) plus ASI03 (Identity & Privilege Abuse -- authn drift) defense.
---

# Next.js Server Action Safety

> Phase 2 Step 4 scaffold. Skill body is authored in session 4 batch 2.
> See `specs/phase-2/D-stack-specific-skills.md` REQ-D1 through REQ-D7 for
> the requirement bar this skill satisfies.
