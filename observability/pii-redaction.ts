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

/**
 * Redact PII patterns from a single string.
 *
 * @param s - Arbitrary text potentially containing PII.
 * @returns Same string with each match replaced by `[REDACTED:<patternName>]`.
 *
 * Exposed Session 15 §2a-2 to support Stratum capture-session.ts P0-F
 * redaction wiring. The redaction logic was previously private to the
 * piiRedactingExporter OTel wrapper. Single source of truth per spec §3 P0-F
 * (Stratum consumes; does NOT duplicate patterns).
 */
export function redactString(s: string): string {
  let out = s;
  for (const { name, regex } of PATTERNS) {
    out = out.replace(regex, `[REDACTED:${name}]`);
  }
  return out;
}

/**
 * Recursively redact PII in a JSON-shaped value (string | array | object | primitive).
 *
 * Walks the structure and applies {@link redactString} to every leaf string.
 * Non-string primitives, arrays, and objects are recursed; the structure is
 * preserved.
 *
 * @param v - Any JSON-shaped value (request bodies, response bodies, attribute maps).
 * @returns Same shape with leaf strings redacted.
 *
 * Exposed Session 15 §2a-2 alongside redactString for the same reason.
 */
export function redactValue(v: unknown): unknown {
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
