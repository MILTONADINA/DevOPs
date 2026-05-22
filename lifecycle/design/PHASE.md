# Phase: Design

## Skills bundle

- security/owasp-asi-threat-model
- development/ears-spec-writing
- development/openapi-first

## Activities

- C4 diagrams (context, container, component levels)
- ERD (entity relationship)
- API contract (OpenAPI 3.1)
- Threat models per major feature (STRIDE + ASI 2026)
- ADRs for non-obvious choices

## Acceptance gates

- [ ] `docs/architecture.md` written
- [ ] `openapi/*.yml` for every external API
- [ ] Threat models for every spec touching auth / data / agents
- [ ] ADRs filed for: database, framework, auth, deploy, observability
