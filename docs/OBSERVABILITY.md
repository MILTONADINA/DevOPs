# Observability

See `observability/README.md` for the active setup.

## Stack

- OpenTelemetry (industry standard)
- OpenInference semantic conventions (LLM-specific spans)
- Per-tenant baggage (`user.id`, `tenant.id` propagated through call tree)
- Inline PII redaction at exporter

## Backends

| Backend | Best for | Self-host? |
|---------|----------|------------|
| Langfuse | Prompt-centric, evals | yes |
| Laminar | Long-running agents, replay | yes |
| Arize Phoenix | Evaluation-heavy | yes |

## Key invariant

PII never reaches the observability backend. The
`piiRedactingExporter` in `observability/pii-redaction.ts` wraps every exporter.

Required for COPPA / HIPAA / GDPR scope.
