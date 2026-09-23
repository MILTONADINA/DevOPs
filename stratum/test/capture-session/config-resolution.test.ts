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

  test('axios POST URL uses ANTHROPIC_BASE_URL env var (Q4 wired Session 15 §2a)', async () => {
    // Q4 binding: env-var primary (ANTHROPIC_BASE_URL), with safe default of
    // https://api.anthropic.com. test/setup.ts sets ANTHROPIC_BASE_URL to
    // 'http://localhost:0/mock' before module load; capture-session.ts
    // snapshots that value at module load and forwards to <BASE>/v1/messages.
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    // setup.ts sets ANTHROPIC_BASE_URL = 'http://localhost:0/mock'
    expect(captureState.axios.postCalls[0].url).toBe('http://localhost:0/mock/v1/messages');
    expect(captureState.axios.postCalls[0].url).not.toContain('api.anthropic.com');
  });

  test('ANTHROPIC_BASE_URL is snapshotted at module-load (mid-run env mutation does NOT affect URL)', async () => {
    // Determinism guard for AC-S15-2a-1.4. Mid-run env mutation must NOT
    // change which URL axios posts to. capture-session.ts reads
    // ANTHROPIC_BASE_URL once at module load; subsequent mutations are
    // no-ops for the forward path.
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'http://MUTATED.example.com';
    try {
      await handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 },
        }),
        buildMockReply()
      );
    } finally {
      process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
    }

    // The forward URL must reflect the snapshot, not the mutated value.
    expect(captureState.axios.postCalls[0].url).toBe('http://localhost:0/mock/v1/messages');
    expect(captureState.axios.postCalls[0].url).not.toContain('MUTATED');
  });

});

// Separate describe block for fail-fast tests: these need vi.resetModules() +
// spyOn(process.exit) to isolate the failure path. They MUST NOT share the
// outer describe's beforeAll-imports-capture-session pattern (which would
// short-circuit module re-load).

describe('config-resolution fail-fast on invalid base URL (Session 15 §2a AC-S15-2a-1.3)', () => {
  test('unparseable ANTHROPIC_BASE_URL exits non-zero at module load', async () => {
    const { vi: viLocal } = await import('vitest');
    const exitSpy = viLocal.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__process_exit_called__');
    }) as never);
    const errorSpy = viLocal.spyOn(console, 'error').mockImplementation(() => undefined);

    const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'not-a-valid-url';

    try {
      viLocal.resetModules();
      await expect(import('../../scripts/capture-session')).rejects.toThrow('__process_exit_called__');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorMessages = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errorMessages.toLowerCase()).toMatch(/anthropic_base_url|invalid|url/);
    } finally {
      process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      viLocal.resetModules();
      // Re-import the module under valid env to restore canonical fastify-route registration
      // for any tests in the same file run after this one (defensive; describe blocks are
      // typically isolated but vi.mock state persists across them in the same file).
      await import('../../scripts/capture-session').catch(() => undefined);
    }
  });

  test('non-http(s) scheme (ftp://) rejected at module load', async () => {
    const { vi: viLocal } = await import('vitest');
    const exitSpy = viLocal.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__process_exit_called__');
    }) as never);
    const errorSpy = viLocal.spyOn(console, 'error').mockImplementation(() => undefined);

    const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'ftp://example.com';

    try {
      viLocal.resetModules();
      await expect(import('../../scripts/capture-session')).rejects.toThrow('__process_exit_called__');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errorMessages = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errorMessages.toLowerCase()).toMatch(/scheme|http|protocol/);
    } finally {
      process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      viLocal.resetModules();
      await import('../../scripts/capture-session').catch(() => undefined);
    }
  });
});
