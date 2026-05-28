// Test #12 — injection-resilience (Session 15 §2a-4 AC-S15-2a-4.1)
//
// Adversarial tests for PII redaction edge cases. Covers:
//   (a) Idempotency: redactor output is stable on re-redaction (no double-redact)
//   (b) Regex metacharacters: literal `.*`, `(?:...)`, `\b` in messages do NOT
//       cause redactor regex to misfire / ReDoS / incorrect matches
//   (c) Unicode + emoji: preserved correctly through capture + redaction (UTF-8 safety)

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import {
  captureState,
  getCaptureHandler,
  setAxiosResponse,
  resetMockState,
  getLastSessionWrite,
} from '../helpers/capture-harness';
import { resetAnthropicMock, loadMockResponse } from '../mocks/anthropic-sdk';
import { buildMockRequest, buildMockReply } from '../mocks/fastify-shapes';

beforeAll(async () => {
  await import('../../scripts/capture-session');
});

describe('injection-resilience (AC-S15-2a-4.1: redactor edge cases)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('idempotency: pre-redacted markers in input pass through without double-redact', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    // User-supplied text containing the literal redactor output marker.
    // Real-world scenario: a user pastes a previously-redacted log into
    // Claude Code, expecting the marker text to be preserved as-is.
    const userText = 'I previously got back [REDACTED:email] from your tool — what does that mean?';

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: userText }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const lastWrite = getLastSessionWrite()!;
    const parsedRaw = JSON.stringify(lastWrite.parsed);
    // The marker text should survive the redaction pass unchanged.
    // It does NOT match any PII regex (it's literal brackets + text, not
    // an email/JWT/etc.), so redactor leaves it alone.
    expect(parsedRaw).toContain('[REDACTED:email]');
    // Negative: the marker isn't double-wrapped (e.g., [REDACTED:[REDACTED:email]])
    expect(parsedRaw).not.toContain('[REDACTED:[REDACTED');
    // The surrounding message context survives intact
    expect(parsedRaw).toContain('what does that mean');
  });

  test('regex metacharacters in user input do not break redaction', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    // User text containing literal regex metacharacters. Redactor regex
    // patterns must not interpret these as regex meta — they're literal
    // characters in user data.
    const metaChars = 'How do I use \\b in a regex? Also (?:non-capturing) groups, .* greedy, [a-z]+ classes?';

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: metaChars }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const lastWrite = getLastSessionWrite()!;
    const parsedRaw = JSON.stringify(lastWrite.parsed);
    // The metacharacters should appear in the captured payload literally
    // (JSON-escaped, but the underlying string content is preserved).
    expect(parsedRaw).toContain('non-capturing');
    expect(parsedRaw).toContain('greedy');
    expect(parsedRaw).toContain('classes');
  });

  test('Unicode + emoji content preserved through redaction', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    // Mix of: Latin extended, CJK, emoji, RTL Arabic, math symbols.
    const unicodeText = 'café 日本語 こんにちは 🌍🚀💯 السلام عليكم ∀x ∈ ℝ: ∂f/∂x ≥ 0';

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: unicodeText }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const lastWrite = getLastSessionWrite()!;
    // Parse and access the actual stored string (avoid JSON.stringify
    // escaping artifacts; verify the literal characters round-trip).
    const parsed = lastWrite.parsed as {
      requests: Array<{ request: { messages: Array<{ content: string }> } }>;
    };
    const storedContent = parsed.requests[parsed.requests.length - 1].request.messages[0].content;
    expect(storedContent).toBe(unicodeText);
  });

  test('ReDoS resilience: long alternating-pattern input completes in bounded time', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    // Construct input that might trigger catastrophic backtracking in a
    // poorly-written regex. The 8 redactor regexes in
    // observability/pii-redaction.ts should NOT exhibit super-linear time.
    // 5000-char alternating pattern of digits + hyphens (could trick a
    // naive cc / phone / ssn regex).
    const adversarial = ('1-2-3-' as string).repeat(1000);

    const t0 = Date.now();
    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: adversarial }], max_tokens: 64 },
      }),
      buildMockReply()
    );
    const elapsed = Date.now() - t0;

    // Sane upper bound: redaction of 5KB through 8 regexes should be well
    // under 1 second on any reasonable hardware. If catastrophic
    // backtracking exists, this test would time out via vitest's default
    // 5s test timeout.
    expect(elapsed).toBeLessThan(2000);
  });

  test('content with newlines + tabs preserved (whitespace integrity)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    const withWhitespace = `Multi-line:
Line 2 with tab\there
Line 3 with \r\nCRLF`;

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: withWhitespace }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<{ request: { messages: Array<{ content: string }> } }>;
    };
    const stored = parsed.requests[parsed.requests.length - 1].request.messages[0].content;
    expect(stored).toContain('Line 2 with tab\there');
    expect(stored).toContain('\r\n');
  });
});
