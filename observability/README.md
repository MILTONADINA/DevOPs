# Observability

OpenTelemetry-first. Per-tenant attribution via baggage. PII redacted inline.

## Stack

| Layer | Tool | Why |
|-------|------|-----|
| Spans | OpenTelemetry SDK | Industry standard, backend-agnostic |
| LLM spans | OpenInference conventions | Same semantic conventions across providers |
| Backend | Langfuse OR Laminar OR Phoenix | All accept OTel via OTLP |
| Redaction | inline at exporter | PII never reaches the backend |

## Setup

1. Install: `npm i @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @arizeai/openinference-instrumentation-anthropic`
2. Wire `otel-config.yml` into your bootstrap.
3. Choose a backend. See `langfuse-setup.md` or `laminar-setup.md`.
4. Apply `pii-redaction.ts` as the exporter wrapper.
5. Verify spans show `user.id` + `tenant.id` in baggage. If they don't, the
   middleware isn't running early enough.
