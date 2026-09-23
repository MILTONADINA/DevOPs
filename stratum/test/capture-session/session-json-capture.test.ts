// Test #3 — session-json-capture. Verifies the capture-artifact JSON shape:
// session_id, started_at, total_turns, total_input_tokens, total_output_tokens,
// requests array with per-turn metadata. Multi-turn accumulation correctness.

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

describe('session-json-capture (artifact shape + multi-turn accumulation)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('first turn write contains the canonical top-level keys', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'q1' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const lastWrite = getLastSessionWrite();
    expect(lastWrite).not.toBeNull();
    const parsed = lastWrite!.parsed as Record<string, unknown>;
    expect(parsed).toHaveProperty('session_id');
    expect(parsed).toHaveProperty('started_at');
    expect(parsed).toHaveProperty('total_turns');
    expect(parsed).toHaveProperty('total_input_tokens');
    expect(parsed).toHaveProperty('total_output_tokens');
    expect(parsed).toHaveProperty('requests');
    expect(parsed.requests).toBeInstanceOf(Array);
  });

  test('session_id is a uuid format (per capture-session.ts randomUUID() use)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({ body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 } }),
      buildMockReply()
    );

    const parsed = getLastSessionWrite()!.parsed as { session_id: string };
    expect(parsed.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('per-turn request includes turn, timestamp, request, token_counts, response, elapsed_ms', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'shape check' }],
          max_tokens: 64,
        },
      }),
      buildMockReply()
    );

    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<Record<string, unknown>>;
    };
    const lastReq = parsed.requests[parsed.requests.length - 1];
    expect(lastReq).toHaveProperty('turn');
    expect(lastReq).toHaveProperty('timestamp');
    expect(lastReq).toHaveProperty('request');
    expect(lastReq).toHaveProperty('token_counts');
    expect(lastReq).toHaveProperty('response');
    expect(lastReq).toHaveProperty('elapsed_ms');
    expect(typeof lastReq.elapsed_ms).toBe('number');
  });

  test('token_counts includes input_tokens + message_breakdown array', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'second' },
          ],
          max_tokens: 64,
        },
      }),
      buildMockReply()
    );

    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<{ token_counts: { input_tokens: number; message_breakdown: Array<{ role: string; token_count: number }> } }>;
    };
    const tc = parsed.requests[parsed.requests.length - 1].token_counts;
    expect(typeof tc.input_tokens).toBe('number');
    expect(tc.message_breakdown).toBeInstanceOf(Array);
    expect(tc.message_breakdown.length).toBe(3);
    expect(tc.message_breakdown[0].role).toBe('user');
    expect(tc.message_breakdown[1].role).toBe('assistant');
  });

  test('total_input_tokens + total_output_tokens accumulate across turns', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    // Turn 1
    await handler(
      buildMockRequest({ body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'a' }], max_tokens: 64 } }),
      buildMockReply()
    );
    const afterTurn1 = getLastSessionWrite()!.parsed as { total_input_tokens: number; total_output_tokens: number; total_turns: number };
    const t1Input = afterTurn1.total_input_tokens;
    const t1Output = afterTurn1.total_output_tokens;
    const t1Turns = afterTurn1.total_turns;

    // Turn 2
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);
    await handler(
      buildMockRequest({ body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'b' }], max_tokens: 64 } }),
      buildMockReply()
    );
    const afterTurn2 = getLastSessionWrite()!.parsed as { total_input_tokens: number; total_output_tokens: number; total_turns: number };

    expect(afterTurn2.total_turns).toBe(t1Turns + 1);
    expect(afterTurn2.total_input_tokens).toBeGreaterThan(t1Input);
    expect(afterTurn2.total_output_tokens).toBeGreaterThan(t1Output);
  });

  test('session JSON path matches OUTPUT_DIR/session-<uuid>.json convention', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({ body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 } }),
      buildMockReply()
    );

    const write = getLastSessionWrite()!;
    const parsed = write.parsed as { session_id: string };
    // Path must end with session-<uuid>.json and contain data/sessions
    expect(write.path).toMatch(/[\\/]data[\\/]sessions[\\/]session-[0-9a-f-]+\.json$/);
    expect(write.path).toContain(parsed.session_id);
  });
});
