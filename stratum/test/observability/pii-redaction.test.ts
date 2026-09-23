// Unit tests for observability/pii-redaction.ts
//
// The redactor is consumed by two callers now:
//   1) observability/ piiRedactingExporter — OTel span attribute redaction
//   2) stratum/scripts/capture-session.ts — capture artifact redaction
//
// Direct unit coverage here protects the redactor's public API against
// regression. The bounded quantifiers (Session 15 §2a-2 fix) are exercised
// explicitly to prevent the ReDoS bug from reappearing.

import { describe, test, expect } from 'vitest';
import { redactString, redactValue, MAX_REDACT_LEN } from '../../../observability/pii-redaction';

// ReDoS-resilience timing helpers. These tests guard against CATASTROPHIC
// backtracking, whose failure mode on these ~500-600KB inputs is a HANG (O(N²)/
// exponential = seconds-to-minutes). The REAL catcher is the per-test TIMEOUT; the
// wall-clock bound is a GENEROUS backstop. It was widened from a tight 1s — which
// flaked under heavy parallel test load (the linear path is ~300ms in isolation but
// jittered to ~1.2s under 53-file load; PB-40) — to a value far below the
// catastrophic regime yet well above load jitter. The load-independent signal is
// the correctness assertion: a backtracking regex cannot produce the clean result.
const REDOS_BACKSTOP_MS = 5_000;
const REDOS_TIMEOUT_MS = 10_000;
const elapsedMs = (fn: () => void): number => {
  const t0 = Date.now();
  fn();
  return Date.now() - t0;
};

describe('pii-redaction — pattern detection', () => {
  test('email is redacted', () => {
    expect(redactString('contact me at user@example.com please')).toBe(
      'contact me at [REDACTED:email] please',
    );
  });

  test('US phone is redacted', () => {
    expect(redactString('call 415-555-1234 anytime')).toBe('call [REDACTED:phone-us] anytime');
  });

  test('SSN is redacted', () => {
    expect(redactString('SSN: 123-45-6789')).toBe('SSN: [REDACTED:ssn]');
  });

  test('credit card is redacted', () => {
    // Note: cc regex `(?:\d[ -]?){13,19}` is greedy on the trailing
    // separator, so a trailing space adjacent to the cc digits can be
    // consumed into the match — assert pattern presence + absence of
    // raw cc, not exact whitespace.
    const out = redactString('card 4111-1111-1111-1111 expires soon');
    expect(out).toContain('[REDACTED:cc]');
    expect(out).not.toContain('4111-1111-1111-1111');
    expect(out).toContain('card ');
    expect(out).toContain('expires soon');
  });

  test('JWT is redacted', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactString(`token: ${jwt}`)).toBe('token: [REDACTED:jwt]');
  });

  test('Bearer token is redacted (case-insensitive)', () => {
    expect(redactString('Authorization: Bearer abcdef1234567890abcdef1234'))
      .toBe('Authorization: [REDACTED:bearer]');
    expect(redactString('Authorization: bearer abcdef1234567890abcdef1234'))
      .toBe('Authorization: [REDACTED:bearer]');
  });

  test('sk- API key is redacted', () => {
    expect(redactString('key=sk-abc123def456ghi789jkl012mno'))
      .toBe('key=[REDACTED:sk-key]');
  });

  test('CQ proxy API key (cq_live_/cq_test_) is redacted', () => {
    expect(redactString('my key is cq_live_abc123def456ghi789jkl012mnop please'))
      .toBe('my key is [REDACTED:cq-key] please');
    expect(redactString('cq_test_abcdefghijklmnopqrstuvwxyz0123'))
      .toBe('[REDACTED:cq-key]');
  });

  test('AWS access key is redacted', () => {
    expect(redactString('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'))
      .toBe('AWS_ACCESS_KEY_ID=[REDACTED:aws-key]');
  });

  test('AWS SECRET access key is redacted ONLY in its labeled context (PB-26) — no false positives', () => {
    // The 40-char secret following a "secret access key" label → redacted (label kept).
    expect(redactString('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('aws_secret_access_key=[REDACTED:aws-secret]');
    expect(redactString('secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'))
      .toContain('[REDACTED:aws-secret]');
    // A bare 40-char base64 string with NO secret-key label → NOT redacted (avoids false positives).
    const bare = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'; // 40 chars, no context
    expect(redactString('hash=' + bare)).toBe('hash=' + bare);
  });
});

describe('pii-redaction — oversized input cap (PB-24)', () => {
  test('a string over MAX_REDACT_LEN is redacted wholesale to a length-tagged placeholder (no multi-second scan)', () => {
    const big = 'x'.repeat(MAX_REDACT_LEN + 1);
    expect(redactString(big)).toBe(`[REDACTED:oversized-${MAX_REDACT_LEN + 1}]`);
  });
  test('a string at/under the cap is redacted normally', () => {
    const ok = 'contact user@example.com';
    expect(redactString(ok)).toBe('contact [REDACTED:email]');
    expect(redactString('y'.repeat(MAX_REDACT_LEN))).toBe('y'.repeat(MAX_REDACT_LEN)); // exactly at cap → scanned (no match)
  });
  test('oversized cap also applies through redactValue (nested leaf)', () => {
    const out = redactValue({ messages: [{ content: 'z'.repeat(MAX_REDACT_LEN + 5) }] }) as { messages: { content: string }[] };
    expect(out.messages[0]!.content).toBe(`[REDACTED:oversized-${MAX_REDACT_LEN + 5}]`);
  });
});

describe('pii-redaction — bounded quantifiers (ReDoS resilience)', () => {
  test('a no-PII input AT the redaction cap completes without catastrophic backtracking', () => {
    // Session 15 §2a-2 regression test for the email-regex backtracking bug.
    // Pre-fix: `[a-zA-Z0-9._%+-]+@...` was O(N²) on long no-`@` inputs (would HANG).
    // Post-fix: bounded `{1,64}` makes it linear-time. Sized at MAX_REDACT_LEN-1 — the LARGEST input the
    // regex ever scans (PB-24 short-circuits anything larger), so this proves linearity at the boundary.
    const input = 'x'.repeat(MAX_REDACT_LEN - 1);
    let out = '';
    const elapsed = elapsedMs(() => {
      out = redactString(input);
    });
    expect(out).toBe(input); // no PII patterns match → input unchanged (proves linear completion)
    expect(elapsed).toBeLessThan(REDOS_BACKSTOP_MS);
  }, REDOS_TIMEOUT_MS);

  test('email with realistic 64-char local part still detected', () => {
    // RFC 5321 max local part = 64 chars
    const localPart = 'a'.repeat(64);
    const input = `${localPart}@example.com`;
    expect(redactString(input)).toBe('[REDACTED:email]');
  });

  test('email with an over-RFC-length local part is redacted IN FULL (no leading-char leak)', () => {
    // The left-anchor lookbehind pins the match to the local-part start, so a >64-char local part is
    // captured whole — the prior bare {1,64} left the leading chars unredacted (a partial PII leak).
    expect(redactString('b'.repeat(65) + '@example.com')).toBe('[REDACTED:email]');
    expect(redactString('john.smith.' + 'x'.repeat(100) + '@example.com')).toBe('[REDACTED:email]');
  });

  test('200KB string with one embedded email: email IS redacted, surrounding bulk preserved', () => {
    const padding = 'x'.repeat(100_000);
    const input = `${padding} user@example.com ${padding}`;
    let out = '';
    const elapsed = elapsedMs(() => {
      out = redactString(input);
    });
    expect(out).toContain('[REDACTED:email]');
    expect(out).not.toContain('user@example.com');
    expect(elapsed).toBeLessThan(REDOS_BACKSTOP_MS);
  }, REDOS_TIMEOUT_MS);
});

describe('pii-redaction — upper-bound leak prevention (§2a redo regression)', () => {
  // These tests guard the fail-OPEN secret leak that adversarial re-verification
  // caught: the original §2a {1,4096} upper bounds on JWT/sk-/Bearer caused
  // over-long tokens to leak (JWT failed the whole match; sk-/Bearer left a raw
  // overflow tail). The fix makes those patterns suffix-free greedy + unbounded.
  // The literal anchors keep them linear, so unbounding is safe.

  test('JWT with a >4096-char segment is FULLY redacted (was a total leak)', () => {
    // A JWT whose middle segment far exceeds the old 4096 cap (Azure AD tokens
    // with embedded x5c cert chains / large claim sets do this).
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + 'A'.repeat(5000) + '.c2lnbmF0dXJl';
    const out = redactString(`auth token is ${jwt} end`);
    expect(out).toContain('[REDACTED:jwt]');
    // The raw token must NOT survive — no long run of the segment leaks.
    expect(out).not.toContain('A'.repeat(100));
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    // Surrounding context is preserved.
    expect(out).toContain('auth token is ');
    expect(out).toContain(' end');
  });

  test('sk- key longer than 4096 chars is FULLY redacted (no raw overflow tail)', () => {
    const key = 'sk-' + 'a'.repeat(5000);
    const out = redactString(`key=${key}`);
    expect(out).toBe('key=[REDACTED:sk-key]');
    // No residual raw-secret tail.
    expect(out).not.toContain('a'.repeat(50));
  });

  test('Bearer token longer than 4096 chars is FULLY redacted (no raw overflow tail)', () => {
    const tok = 'b'.repeat(5000);
    const out = redactString(`Authorization: Bearer ${tok}`);
    expect(out).toBe('Authorization: [REDACTED:bearer]');
    expect(out).not.toContain('b'.repeat(50));
  });

  test('normal compact JWT still collapses to a single [REDACTED:jwt] marker', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactString(`token: ${jwt}`)).toBe('token: [REDACTED:jwt]');
  });

  test('ReDoS guard: 600KB of repeated "eyJ" redacts in one linear pass', () => {
    // The PRIOR 3-segment JWT form (eyJ[...]+\.[...]+\.[...]+) was O(N^2) on this
    // input — each "eyJ" start backtracked hunting a required ".". The suffix-free
    // greedy form matches the whole run in ONE pass → linear.
    let out = '';
    const elapsed = elapsedMs(() => {
      out = redactString('eyJ'.repeat(80_000)); // ~240KB — under the PB-24 cap, so actually scanned
    });
    expect(out).toBe('[REDACTED:jwt]'); // entire run consumed in one match (a backtracker can't)
    expect(elapsed).toBeLessThan(REDOS_BACKSTOP_MS);
  }, REDOS_TIMEOUT_MS);

  test('ReDoS guard: repeated "eyJa.b" near-matches redact in one linear pass', () => {
    let out = '';
    const elapsed = elapsedMs(() => {
      out = redactString('eyJa.b'.repeat(40_000)); // ~240KB of dot-laced near-JWTs (under the PB-24 cap → scanned)
    });
    expect(out).toContain('[REDACTED:jwt]');
    expect(out).not.toContain('eyJa.b'.repeat(10));
    expect(elapsed).toBeLessThan(REDOS_BACKSTOP_MS);
  }, REDOS_TIMEOUT_MS);
});

describe('pii-redaction — redactValue recursion', () => {
  test('redacts string leaves in nested object', () => {
    const input = {
      name: 'alice',
      email: 'alice@example.com',
      profile: { phone: '415-555-1234', age: 30 },
    };
    const out = redactValue(input) as typeof input;
    expect(out.name).toBe('alice');
    expect(out.email).toBe('[REDACTED:email]');
    expect(out.profile.phone).toBe('[REDACTED:phone-us]');
    expect(out.profile.age).toBe(30);
  });

  test('redacts string leaves in arrays', () => {
    const input = ['hello', 'contact@foo.com', 42, ['nested', 'jane@bar.org']];
    const out = redactValue(input) as unknown[];
    expect(out[0]).toBe('hello');
    expect(out[1]).toBe('[REDACTED:email]');
    expect(out[2]).toBe(42);
    expect((out[3] as unknown[])[1]).toBe('[REDACTED:email]');
  });

  test('preserves null + undefined + booleans', () => {
    expect(redactValue(null)).toBe(null);
    expect(redactValue(undefined)).toBe(undefined);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(false)).toBe(false);
  });

  test('preserves numbers + Date-like primitives', () => {
    expect(redactValue(123)).toBe(123);
    expect(redactValue(3.14)).toBe(3.14);
    expect(redactValue(0)).toBe(0);
  });

  test('structure-preserving: object keys unchanged', () => {
    const input = { 'key-with-dashes': 'val', 'email@key': 'val2' };
    const out = redactValue(input) as Record<string, unknown>;
    // Keys are NOT redacted (only string values)
    expect(Object.keys(out).sort()).toEqual(['email@key', 'key-with-dashes']);
  });
});

describe('pii-redaction — idempotency', () => {
  test('re-redacting an already-redacted string is a no-op', () => {
    const input = 'Hello [REDACTED:email] and [REDACTED:phone-us]';
    expect(redactString(input)).toBe(input);
  });
});
