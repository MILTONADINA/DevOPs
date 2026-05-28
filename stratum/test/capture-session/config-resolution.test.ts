// Test #9 — config-resolution. Q4 binding: env-var primary, config-file
// secondary, no CLI flag. Q4 + Q6 + Q7 intersection at capture-session
// startup time.

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import {
  captureState,
  getCaptureHandler,
  setAxiosResponse,
  resetMockState,
} from '../helpers/capture-harness';
import { resetAnthropicMock, loadMockResponse } from '../mocks/anthropic-sdk';
import { buildMockRequest, buildMockReply } from '../mocks/fastify-shapes';

beforeAll(async () => {
  await import('../../scripts/capture-session');
});

describe('config-resolution (Q4: env-var primary; Q6 default; Q7 sentinel)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('ANTHROPIC_API_KEY is set in test env (capture-session.ts fail-fast precondition)', () => {
    expect(process.env.ANTHROPIC_API_KEY).toBe('test-sk-mock');
  });

  test('ANTHROPIC_BASE_URL is set in test env (Q4 env-var primary)', () => {
    expect(process.env.ANTHROPIC_BASE_URL).toBeDefined();
    expect(process.env.ANTHROPIC_BASE_URL).toMatch(/^https?:\/\//);
  });

  test('STRATUM_DEFAULT_TENANT_ID defaults to "personal" (Q6)', () => {
    expect(process.env.STRATUM_DEFAULT_TENANT_ID).toBe('personal');
  });

  test('OTEL_EXPORTER_OTLP_ENDPOINT empty-string sentinel preserved (Q7: "" distinct from unset)', () => {
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('');
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT === '').toBe(true);
  });

  test('config snapshot captured at module-load (not re-read per request)', async () => {
    // Determinism guard: mid-run env mutation must NOT affect in-flight
    // handler behavior. capture-session.ts reads ANTHROPIC_API_KEY once at
    // module load (line 28) — subsequent env mutations are no-ops for the
    // forward path.
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'MUTATED-KEY-WHICH-MUST-NOT-LEAK';
    try {
      await handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 },
        }),
        buildMockReply()
      );
    } finally {
      process.env.ANTHROPIC_API_KEY = prevKey;
    }

    // The forward call must use the snapshot, not the mutated value.
    const headers = captureState.axios.postCalls[0].config.headers;
    expect(headers['x-api-key']).toBe('test-sk-mock');
    expect(headers['x-api-key']).not.toBe('MUTATED-KEY-WHICH-MUST-NOT-LEAK');
  });

  test('axios POST URL is the Anthropic public endpoint (capture-session.ts current behavior)', async () => {
    // Note: capture-session.ts at HEAD hardcodes the Anthropic endpoint at
    // line 144. Q4's env-var-primary override (ANTHROPIC_BASE_URL) is not
    // yet wired into the forward call. P0-B's streaming work will likely
    // touch this path; until then, assert the current hardcoded behavior
    // honestly.
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    expect(captureState.axios.postCalls[0].url).toBe('https://api.anthropic.com/v1/messages');
  });

  test.todo('once Q4 wiring lands: ANTHROPIC_BASE_URL env var redirects axios POST to override URL');

  test.todo('once Q4 wiring lands: invalid base URL surfaces at config-resolution time (fail-fast), not at first request');
});
