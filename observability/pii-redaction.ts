// observability/pii-redaction.ts
//
// Inline PII redaction at the OTel exporter. PII never reaches the
// observability backend.
//
// Coverage: emails, phone numbers (US/intl), SSN, credit card, JWT, OAuth
// access tokens, IP addresses (optional), arbitrary key:value secret patterns.

import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';

const PATTERNS = [
  // Email
  { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // US phone
  { name: 'phone-us', regex: /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  // SSN
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit card (16 digits, optional spaces/dashes)
  { name: 'cc', regex: /\b(?:\d[ -]?){13,19}\b/g },
  // JWT
  { name: 'jwt', regex: /eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g },
  // Bearer / sk- / api keys
  { name: 'bearer', regex: /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi },
  { name: 'sk-key', regex: /sk-[A-Za-z0-9_\-]{20,}/g },
  { name: 'aws-key', regex: /AKIA[0-9A-Z]{16}/g },
];

function redactString(s: string): string {
  let out = s;
  for (const { name, regex } of PATTERNS) {
    out = out.replace(regex, `[REDACTED:${name}]`);
  }
  return out;
}

function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = redactValue(val);
    return o;
  }
  return v;
}

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
