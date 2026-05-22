---
name: observability-instrument
description: Add OpenTelemetry spans with user_id and tenant_id in baggage to any new code path that handles requests, runs agents, or performs billable operations. Use whenever creating a new API endpoint, background job, agent invocation, or external API call. Inline PII redaction at the span exporter is mandatory before any production deploy.
---

# Observability Instrument

> OpenTelemetry, OpenInference semantic conventions, baggage for per-tenant
> attribution, PII redaction inline. Production-grade from day one.

**Tradeoff:** Every new code path needs instrumentation. Worth it: 73% of agent
quality regressions are caught before users when full tracing is in place (2025
LLMOps survey).

---

## Why baggage matters

Baggage propagates `user_id` and `tenant_id` through the trace context. Every
span automatically inherits them through the call tree. Teams that try to
propagate identity through ad-hoc argument passing always lose it at the first
tool boundary.

Decision: add baggage in week one. Costs two days. Buys per-tenant cost
attribution forever.

---

## Setup (TypeScript / Node)

```typescript
// otel-setup.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { W3CBaggagePropagator, W3CTraceContextPropagator, CompositePropagator } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { piiRedactingExporter } from './pii-redaction.js';

propagation.setGlobalPropagator(new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
}));

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'auth-service',
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.GIT_SHA,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.ENV,
  }),
  traceExporter: piiRedactingExporter(new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  })),
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
```

---

## Adding baggage

At the request entry point:

```typescript
import { context, propagation } from '@opentelemetry/api';

app.use(async (req, res, next) => {
  const baggage = propagation.createBaggage({
    'user.id': { value: req.user?.id ?? 'anonymous' },
    'tenant.id': { value: req.tenant?.id ?? 'unknown' },
    'session.id': { value: req.session?.id ?? 'none' },
  });
  const ctx = propagation.setBaggage(context.active(), baggage);
  context.with(ctx, () => next());
});
```

From this point on, every child span (HTTP call, DB query, agent invocation,
external API) inherits user.id and tenant.id automatically.

---

## OpenInference for LLM calls

Use the OpenInference semantic conventions so you can swap observability
backends (Langfuse, Laminar, Arize Phoenix) without re-instrumenting:

```typescript
import { OpenAI } from 'openai';
import { OpenAIInstrumentation } from '@arizeai/openinference-instrumentation-openai';
// or @arizeai/openinference-instrumentation-anthropic for Anthropic

registerInstrumentations({ instrumentations: [new OpenAIInstrumentation()] });
```

This adds spans like:
- `llm.provider`: anthropic
- `llm.model`: claude-sonnet-4-6
- `llm.input_messages.0.role`: user
- `llm.input_messages.0.content`: (redacted)
- `llm.token_count.prompt`: 1234
- `llm.token_count.completion`: 567
- `llm.cost_usd`: 0.0231

---

## PII redaction (mandatory)

PII never reaches the observability backend. Implement an inline-redacting
exporter at `observability/pii-redaction.ts`:

```typescript
export function piiRedactingExporter(baseExporter) {
  return {
    export(spans, cb) {
      const redacted = spans.map(span => ({
        ...span,
        attributes: redactObject(span.attributes),
        events: span.events?.map(e => ({ ...e, attributes: redactObject(e.attributes) })),
      }));
      return baseExporter.export(redacted, cb);
    },
    shutdown() { return baseExporter.shutdown(); },
  };
}

function redactObject(obj) {
  // Use a library: presidio-analyzer (Python), node-deidentify, or roll your own
  // with regex for: emails, phone numbers, SSN, CC, JWT, OAuth tokens
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    out[k] = typeof v === 'string' ? redactString(v) : v;
  }
  return out;
}
```

---

## Backends supported

| Backend | Best for | Self-hosted? |
|---------|----------|--------------|
| Langfuse | Prompt-centric, evals, datasets | yes (Postgres+ClickHouse) |
| Laminar | Long-running agents, replay, transcript view | yes |
| Arize Phoenix | Evaluation-heavy teams | yes |
| LangSmith | LangChain/LangGraph stacks | cloud only |
| Honeycomb | General APM with LLM extensions | cloud |

All four open-source options accept OTel via OTLP — set the
`OTEL_EXPORTER_OTLP_ENDPOINT` env var.

---

**This skill is working when:** every production span has user.id and tenant.id
in baggage, and every LLM call has token_count + cost_usd attributes. Track
in `governance/telemetry/instrumentation-coverage.jsonl`.
