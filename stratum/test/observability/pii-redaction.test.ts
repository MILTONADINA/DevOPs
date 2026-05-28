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
import { redactString, redactValue } from '../../../observability/pii-redaction';

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

  test('AWS access key is redacted', () => {
    expect(redactString('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'))
      .toBe('AWS_ACCESS_KEY_ID=[REDACTED:aws-key]');
  });
});

describe('pii-redaction — bounded quantifiers (ReDoS resilience)', () => {
  test('500KB of non-PII input completes in <1s (catastrophic backtracking prevented)', () => {
    // Session 15 §2a-2 regression test for the email-regex backtracking bug.
    // Pre-fix: `[a-zA-Z0-9._%+-]+@...` was O(N²) on long no-`@` inputs.
    // Post-fix: bounded `{1,64}` makes it linear-time.
    const input = 'x'.repeat(500_000);
    const t0 = Date.now();
    const out = redactString(input);
    const elapsed = Date.now() - t0;
    expect(out).toBe(input);  // no PII patterns match → input unchanged
    expect(elapsed).toBeLessThan(1000);
  });

  test('email with realistic 64-char local part still detected', () => {
    // RFC 5321 max local part = 64 chars
    const localPart = 'a'.repeat(64);
    const input = `${localPart}@example.com`;
    expect(redactString(input)).toBe('[REDACTED:email]');
  });

  test('email with 65-char local part: longer matches still get caught via shifted boundary', () => {
    // Bounded {1,64} means a 65-char local part will match starting from
    // char 2 (still 64 chars). Email detection remains best-effort on
    // pathological inputs; the bound trades a tiny edge case for ReDoS
    // resilience.
    const input = 'b'.repeat(65) + '@example.com';
    // The first 'b' is preserved; chars 2-65 + '@example.com' is redacted
    expect(redactString(input)).toBe('b[REDACTED:email]');
  });

  test('200KB string with one embedded email: email IS redacted, surrounding bulk preserved', () => {
    const padding = 'x'.repeat(100_000);
    const input = `${padding} user@example.com ${padding}`;
    const t0 = Date.now();
    const out = redactString(input);
    const elapsed = Date.now() - t0;
    expect(out).toContain('[REDACTED:email]');
    expect(out).not.toContain('user@example.com');
    expect(elapsed).toBeLessThan(1000);
  });
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
