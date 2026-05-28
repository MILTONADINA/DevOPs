// Test #8 — otel-soft-dep. Q7 binding: OTel exporter is a soft dep with
// graceful degradation. Empty OTEL_EXPORTER_OTLP_ENDPOINT MUST NOT crash
// the proxy; unreachable endpoint MUST degrade to stderr fallback.
//
// Note: capture-session.ts at HEAD does NOT yet emit OTel events. P0-G
// (Session 15+) wires that in. These tests assert the CURRENT graceful
// behavior (no OTel calls = no crash) and document the EXPECTED state for
// P0-G via test.todo markers. This is honest scaffold-state assertion.

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import {
  getCaptureHandler,
  setAxiosResponse,
  resetMockState,
} from '../helpers/capture-harness';
import { resetAnthropicMock, loadMockResponse } from '../mocks/anthropic-sdk';
import { buildMockRequest, buildMockReply } from '../mocks/fastify-shapes';

beforeAll(async () => {
  await import('../../scripts/capture-session');
});

describe('otel-soft-dep (Q7: graceful degradation when OTel unavailable)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('empty OTEL_EXPORTER_OTLP_ENDPOINT is set by setup.ts (Q7 default)', () => {
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('');
  });

  test('proxy handles request with empty OTel endpoint without crashing', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await expect(
      handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 },
        }),
        buildMockReply()
      )
    ).resolves.not.toThrow();
  });

  test('unreachable OTel endpoint does not block proxy forward (graceful degradation invariant)', async () => {
    // Simulate an unreachable endpoint by stubbing env. capture-session.ts
    // at HEAD doesn't read this env var, so this assertion is a forward-
    // compatibility guard: the proxy must continue working regardless of
    // the env value. P0-G will add the actual OTel emit path; this test
    // ensures that path is non-blocking when wired.
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:1/dead';
    try {
      const handler = getCaptureHandler();
      setAxiosResponse(loadMockResponse('simple-text-response'), 200);
      const reply = buildMockReply();
      await handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 },
        }),
        reply
      );
      expect(reply.__recorded.sent).toBe(true);
    } finally {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
    }
  });

  test.todo('once P0-G lands: empty endpoint → no exporter init; structured stderr log emitted');
  test.todo('once P0-G lands: unreachable endpoint → stderr fallback log per event; no crash');
  test.todo('once P0-G lands: valid endpoint → OTel spans emitted with stratum.session.start + .turn.recorded names');
});
