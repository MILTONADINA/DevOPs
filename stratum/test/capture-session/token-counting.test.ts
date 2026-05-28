// Test #7 — token-counting. Q2 binding: per-turn live countTokens via
// @anthropic-ai/sdk; no batching; exact counts not estimates.

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import {
  getCaptureHandler,
  setAxiosResponse,
  resetMockState,
  getLastSessionWrite,
} from '../helpers/capture-harness';
import {
  resetAnthropicMock,
  loadMockResponse,
  getCountTokensCalls,
} from '../mocks/anthropic-sdk';
import { buildMockRequest, buildMockReply } from '../mocks/fastify-shapes';

beforeAll(async () => {
  await import('../../scripts/capture-session');
});

describe('token-counting (Q2: per-turn live countTokens)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('countTokens called once for total + once per message (granular breakdown)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    await handler(
      buildMockRequest({ body: { model: 'claude-opus-4-7', messages, max_tokens: 64 } }),
      buildMockReply()
    );

    const calls = getCountTokensCalls();
    // 1 total + 3 per-message = 4 calls
    expect(calls.length).toBe(1 + messages.length);
    // First call is the aggregate (full messages array)
    expect((calls[0].messages as unknown[]).length).toBe(messages.length);
    // Subsequent calls are single-message each
    for (let i = 1; i < calls.length; i++) {
      expect((calls[i].messages as unknown[]).length).toBe(1);
    }
  });

  test('per-turn invocation (not batched): two turns produce two independent count cycles', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);
    resetAnthropicMock();

    // Turn 1: 2 messages → 1 + 2 = 3 calls
    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
          ],
          max_tokens: 64,
        },
      }),
      buildMockReply()
    );
    const callsAfterT1 = getCountTokensCalls().length;
    expect(callsAfterT1).toBe(3);

    // Turn 2: 3 messages → 1 + 3 = 4 calls → cumulative 7
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
    expect(getCountTokensCalls().length).toBe(callsAfterT1 + 4);
  });

  test('input_tokens recorded from countTokens result; output_tokens from response.usage', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'short' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const parsed = getLastSessionWrite()!.parsed as {
      total_input_tokens: number;
      total_output_tokens: number;
      requests: Array<{
        response: { usage: { input_tokens: number; output_tokens: number } };
        token_counts: { input_tokens: number };
      }>;
    };
    const lastReq = parsed.requests[parsed.requests.length - 1];
    // output_tokens flows from the fixture's response.usage block (8 in simple-text-response)
    expect(lastReq.response.usage.output_tokens).toBe(8);
    expect(lastReq.response.usage.input_tokens).toBe(12);
    // Local countTokens result is recorded separately as input_tokens
    expect(lastReq.token_counts.input_tokens).toBeGreaterThan(0);
  });

  test('countTokens forwards system + tools to the SDK when present (exact-counts honoured)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('tool-use-response'), 200);
    resetAnthropicMock();

    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'check weather' }],
          max_tokens: 256,
          system: 'You can use tools.',
          tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object' } }],
        },
      }),
      buildMockReply()
    );

    const calls = getCountTokensCalls();
    // The aggregate call includes system + tools (per capture-session.ts spreads)
    const aggregate = calls[0];
    expect(aggregate.system).toBe('You can use tools.');
    expect(aggregate.tools).toBeInstanceOf(Array);
    expect(aggregate.tools).toHaveLength(1);
  });
});
