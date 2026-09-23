// stratum/test/capture-session/proxy-passthrough.test.ts
// Test #1 (template) — proxy-passthrough non-streaming happy path.
// All mocks registered in test/setup.ts (vitest setupFiles). This file is
// pure business logic.

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import {
  captureState,
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
  // Trigger module-load of the production entry point (against setup.ts mocks).
  await import('../../scripts/capture-session');
});

describe('proxy-passthrough (non-streaming happy path)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('simple text response is forwarded with original body shape', async () => {
    const handler = getCaptureHandler();
    const fixture = loadMockResponse('simple-text-response');
    setAxiosResponse(fixture, 200);

    const req = buildMockRequest({
      body: {
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'What is the capital of France?' }],
        max_tokens: 64,
      },
    });
    const reply = buildMockReply();

    await handler(req, reply);

    expect(captureState.axios.postCalls).toHaveLength(1);
    // Q4 wiring (Session 15 §2a-1): URL derived from ANTHROPIC_BASE_URL env;
    // setup.ts sets it to 'http://localhost:0/mock'. Pre-Q4 this asserted
    // the hardcoded 'https://api.anthropic.com/v1/messages'.
    expect(captureState.axios.postCalls[0].url).toBe('http://localhost:0/mock/v1/messages');
    expect(captureState.axios.postCalls[0].body).toMatchObject({
      model: 'claude-opus-4-7',
      max_tokens: 64,
    });
    expect(reply.__recorded.body).toEqual(fixture);
  });

  test('request body forwarded verbatim (model + messages + max_tokens + system preserved)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    const body = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'second turn' },
      ],
      max_tokens: 256,
      system: 'You are concise.',
    };
    await handler(buildMockRequest({ body }), buildMockReply());

    expect(captureState.axios.postCalls).toHaveLength(1);
    expect(captureState.axios.postCalls[0].body).toEqual(body);
  });

  test('Anthropic API key forwarded via x-api-key header (NEVER in body)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const config = captureState.axios.postCalls[0].config;
    expect(config.headers['x-api-key']).toBe('test-sk-mock');
    expect(config.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.stringify(captureState.axios.postCalls[0].body)).not.toContain('test-sk-mock');
  });

  test('session JSON written to disk after each turn (capture artifact)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'test' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const lastWrite = getLastSessionWrite();
    expect(lastWrite).not.toBeNull();
    expect(lastWrite!.path).toMatch(/session-.*\.json$/);
    const parsed = lastWrite!.parsed as {
      session_id: string;
      requests: Array<{ request: { model: string }; response: { id: string } }>;
    };
    expect(parsed.session_id).toBeDefined();
    expect(parsed.requests).toBeInstanceOf(Array);
    expect(parsed.requests.length).toBeGreaterThanOrEqual(1);
    const lastReq = parsed.requests[parsed.requests.length - 1];
    expect(lastReq.request.model).toBe('claude-opus-4-7');
    expect(lastReq.response.id).toBe('msg_01ABC123simple');
  });

  test('countTokens invoked at least once per turn (Q2: per-turn live counts)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);
    resetAnthropicMock();

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'one' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    expect(getCountTokensCalls().length).toBeGreaterThanOrEqual(1);
  });
});
