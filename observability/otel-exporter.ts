// observability/otel-exporter.ts
//
// OTel SpanExporter wrapper that PII-redacts span + event attributes before
// they reach the observability backend. The redaction logic itself lives in
// ./pii-redaction (pure, dependency-free, single source of truth per spec §3
// P0-F); this file is the thin OTel integration layer that carries the
// @opentelemetry type dependency.
//
// Split out of pii-redaction.ts in the §2a-redo PB-23 cleanup so that consumers
// needing only the pure redactor (e.g. Stratum's capture-session.ts) can import
// redactValue/redactString WITHOUT transitively pulling the @opentelemetry type
// packages into their typecheck.

import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';
import { redactValue } from './pii-redaction';

/**
 * Wrap a base OTel SpanExporter so every span attribute + event attribute is
 * PII-redacted before export. PII never reaches the observability backend.
 *
 * @param base - The downstream SpanExporter to forward redacted spans to.
 * @returns A SpanExporter that redacts attributes, then delegates to `base`.
 */
export function piiRedactingExporter(base: SpanExporter): SpanExporter {
  return {
    export(spans: ReadableSpan[], cb: (r: ExportResult) => void) {
      const redacted = spans.map(span => ({
        ...span,
        attributes: Object.fromEntries(
          Object.entries(span.attributes ?? {}).map(([k, v]) => [k, redactValue(v)]),
        ),
        events: span.events?.map(e => ({
          ...e,
          attributes: Object.fromEntries(
            Object.entries(e.attributes ?? {}).map(([k, v]) => [k, redactValue(v)]),
          ),
        })),
      })) as ReadableSpan[];
      return base.export(redacted, cb);
    },
    shutdown() { return base.shutdown(); },
  };
}
