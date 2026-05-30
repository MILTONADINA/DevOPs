// observability/pii-redaction.ts
//
// Pure, dependency-free PII redaction. Consumed by the OTel SpanExporter
// wrapper (./otel-exporter.ts) AND by Stratum's capture-session.ts (P0-F).
// Keeping this module free of any external import lets cross-subtree consumers
// typecheck it without transitively pulling @opentelemetry (PB-23, §2a-redo).
//
// Coverage: emails, phone numbers (US/intl), SSN, credit card, JWT, OAuth
// access tokens, arbitrary key:value secret patterns.

// Quantifier discipline (Session 15 §2a-2, hardened in the §2a redo after
// adversarial re-verification caught a fail-OPEN secret leak).
//
// Catastrophic backtracking arises only when a quantified character class has
// NO literal anchor AND is followed by a REQUIRED suffix the engine must hunt
// for. The email local-part is the canonical case: `[...]+@…tld` has no anchor,
// so the engine retries at every offset (O(N) start positions) and each start
// backtracks O(N) looking for `@` → O(N²). The CORRECT fix for THAT shape is a
// bound (email local-part {1,64} per RFC 5321 §4.5.3.1.1, domain {1,253} per
// RFC 1035). A bound is safe there: an over-length local-part still matches
// from a shifted offset, so at most a few leading local-part chars escape —
// never the @domain.
//
// A bound is the WRONG tool for a literal-anchored, SUFFIX-FREE greedy class
// (eyJ…, Bearer…, sk-…). Those are ALREADY linear — the literal anchor caps the
// number of start positions and the greedy class succeeds WITHOUT backtracking
// because nothing required follows it. Adding an upper bound there does not
// improve time but DOES introduce a fail-OPEN leak: a token longer than the cap
// either fails the whole (suffix-requiring) match — JWT — or leaves a raw
// overflow tail — sk-/Bearer — so the secret reaches disk UNREDACTED. The first
// §2a pass made exactly this mistake: bounding the JWT segments to {1,4096}
// meant a JWT with a >4096-char segment leaked in full (reproduced in the redo).
// So JWT/Bearer/sk- are suffix-free greedy and UNBOUNDED here: leak-free and
// still linear. The JWT pattern matches `eyJ` + ONE greedy base64url-or-dot run,
// consuming the whole compact token (incl. its `.` separators) in a single pass
// — which also kills the O(N²) the prior REQUIRED-`.` 3-segment form had on
// `eyJ`-repeated input (each `eyJ` start backtracked hunting the next dot).
const PATTERNS = [
  // Email — LEFT-ANCHORED (negative lookbehind) + a generous local-part bound. The lookbehind pins
  // each match to the TRUE local-part start (a position not preceded by a local-part char), so the
  // engine can only START a match once per local-part run — that caps start positions to O(1) per run
  // and kills the O(N²) the no-anchor form had. Because the start is pinned, the {1,256} bound is large
  // enough to redact even an over-RFC-length local-part IN FULL (the prior bare {1,64} left a shifted
  // partial match → a few leading local-part chars leaked to disk; see the §2a redo lesson). Still
  // linear: interior positions are skipped O(1) by the failing lookbehind. The 500KB-no-`@` ReDoS
  // backstop test stays green.
  { name: 'email', regex: /(?<![a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]{1,256}@[a-zA-Z0-9.-]{1,253}\.[a-zA-Z]{2,24}/g },
  // US phone
  { name: 'phone-us', regex: /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  // SSN
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit card (13-19 digits with optional separators) — linear under \b anchors
  { name: 'cc', regex: /\b(?:\d[ -]?){13,19}\b/g },
  // JWT — `eyJ`-anchored, suffix-free greedy over base64url + `.`; matches the
  // whole compact token in ONE pass. UNBOUNDED on purpose: leak-free for
  // arbitrarily long tokens (no upper cap to fail past) and linear (no required
  // trailing token to backtrack against). See quantifier-discipline note above.
  { name: 'jwt', regex: /eyJ[A-Za-z0-9._-]+/g },
  // Bearer / sk- / api keys — literal-anchored, suffix-free greedy; UNBOUNDED so
  // an over-long token is fully redacted (no raw overflow tail) and still linear.
  { name: 'bearer', regex: /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi },
  { name: 'sk-key', regex: /sk-[A-Za-z0-9_-]{20,}/g },
  // AWS access key ID (fixed width)
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
