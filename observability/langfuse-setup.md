# Langfuse setup

Prompt-centric LLM observability. Best for teams running structured evals and
dataset-based regression testing.

## Self-hosted (recommended for COPPA/HIPAA scope)

```bash
git clone https://github.com/langfuse/langfuse
cd langfuse
docker-compose up -d
```

Requires Postgres + ClickHouse. ~2GB RAM minimum.

## Configure

```bash
export LANGFUSE_PUBLIC_KEY=pk-...
export LANGFUSE_SECRET_KEY=sk-...
export LANGFUSE_HOST=http://localhost:3000
```

## Wire to OTel

The OTel collector config above exports traces to Langfuse via OTLP.
Alternatively, use the native Langfuse SDK for richer prompt/completion
metadata.

## What Langfuse captures

- Prompt + completion per call
- Token counts and cost
- Latency
- User feedback (thumbs up/down via SDK)
- Eval scores (LLM-as-judge or human)
- Dataset for regression testing

## Privacy

Always apply the PII-redaction exporter before Langfuse sees data. Especially
for COPPA / HIPAA work.
