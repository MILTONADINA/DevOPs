---
name: fastapi-dependency-injection
description: FastAPI dependency-injection patterns and anti-patterns -- request-scoped auth tokens leaking into singleton DI graphs, missing `Depends()` declarations on auth-required routes, `dependency_overrides` mis-use in tests bleeding into production code paths. Triggers on FastAPI route authoring (`@app.get`, `@app.post`, `Depends()` references). OWASP ASI03 (Identity & Privilege Abuse) defense for auth-token handling via DI.
---

# FastAPI Dependency Injection

> Phase 2 Step 4 scaffold. Skill body is authored in session 4 batch 3.
> See `specs/phase-2/D-stack-specific-skills.md` REQ-D1 through REQ-D7 for
> the requirement bar this skill satisfies.
