// Test #4 — proxy-multi-turn. Anthropic Messages API takes the full thread
// per call (no server-side context); capture-session.ts must forward intact
// and accumulate the full thread under one session-id.

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

describe('proxy-multi-turn (thread forwarding + session accumulation)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('multi-message thread forwarded intact (all roles preserved)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('multi-turn-response'), 200);

    const thread = [
      { role: 'user', content: 'tell me about Paris' },
      { role: 'assistant', content: 'Paris is the capital of France...' },
      { role: 'user', content: 'where is the Louvre?' },
    ];
    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: thread, max_tokens: 256 },
      }),
      buildMockReply()
    );

    const fwd = captureState.axios.postCalls[0].body as { messages: typeof thread };
    expect(fwd.messages).toHaveLength(3);
    expect(fwd.messages).toEqual(thread);
  });

  test('system prompt preserved if present', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('multi-turn-response'), 200);

    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 64,
          system: 'You are a concise assistant. Reply in one sentence.',
        },
      }),
      buildMockReply()
    );

    const fwd = captureState.axios.postCalls[0].body as { system: string };
    expect(fwd.system).toBe('You are a concise assistant. Reply in one sentence.');
  });

  test('session JSON captures the full thread under one session-id', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    // Turn 1
    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'q1' }], max_tokens: 64 },
      }),
      buildMockReply()
    );
    const sessionIdAfterT1 = (getLastSessionWrite()!.parsed as { session_id: string }).session_id;

    // Turn 2 — different message but same module-level session
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);
    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
          ],
          max_tokens: 64,
        },
      }),
      buildMockReply()
    );
    const sessionIdAfterT2 = (getLastSessionWrite()!.parsed as { session_id: string }).session_id;

    expect(sessionIdAfterT2).toBe(sessionIdAfterT1);
  });

  test('per-message token breakdown matches thread length', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('multi-turn-response'), 200);

    const thread = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
      { role: 'assistant', content: 'fourth' },
      { role: 'user', content: 'fifth' },
    ];
    await handler(
      buildMockRequest({ body: { model: 'claude-opus-4-7', messages: thread, max_tokens: 64 } }),
      buildMockReply()
    );

    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<{ token_counts: { message_breakdown: Array<{ role: string }> } }>;
    };
    const lastReq = parsed.requests[parsed.requests.length - 1];
    expect(lastReq.token_counts.message_breakdown).toHaveLength(thread.length);
    expect(lastReq.token_counts.message_breakdown.map(m => m.role)).toEqual(
      thread.map(m => m.role)
    );
  });
});
