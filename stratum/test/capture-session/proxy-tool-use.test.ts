// Test #2 — proxy-tool-use. Verifies tool_use content blocks forward
// correctly and mixed-content (text + tool_use) responses preserve their
// shape end-to-end + capture into session JSON with type discrimination.

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

describe('proxy-tool-use (tool_use content block forwarding)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('tool_use content block in response forwarded correctly', async () => {
    const handler = getCaptureHandler();
    const fixture = loadMockResponse('tool-use-response');
    setAxiosResponse(fixture, 200);

    const reply = buildMockReply();
    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
          max_tokens: 256,
          tools: [
            {
              name: 'get_weather',
              description: 'Get current weather',
              input_schema: {
                type: 'object',
                properties: { location: { type: 'string' }, unit: { type: 'string' } },
                required: ['location'],
              },
            },
          ],
        },
      }),
      reply
    );

    const forwarded = reply.__recorded.body as typeof fixture;
    expect(forwarded.content).toHaveLength(1);
    expect(forwarded.content[0].type).toBe('tool_use');
    expect(forwarded.stop_reason).toBe('tool_use');
    if (forwarded.content[0].type === 'tool_use') {
      expect(forwarded.content[0].name).toBe('get_weather');
      expect(forwarded.content[0].input).toEqual({ location: 'Paris, France', unit: 'celsius' });
    }
  });

  test('tools array in request body forwarded verbatim to Anthropic', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('tool-use-response'), 200);

    const tools = [
      {
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: { type: 'object', properties: { location: { type: 'string' } } },
      },
    ];
    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'weather check' }],
          max_tokens: 256,
          tools,
        },
      }),
      buildMockReply()
    );

    expect(captureState.axios.postCalls).toHaveLength(1);
    const fwd = captureState.axios.postCalls[0].body as { tools: unknown };
    expect(fwd.tools).toEqual(tools);
  });

  test('mixed-content response (text + tool_use blocks) preserved end-to-end', async () => {
    const handler = getCaptureHandler();
    const fixture = loadMockResponse('mixed-content-response');
    setAxiosResponse(fixture, 200);

    const reply = buildMockReply();
    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'check weather and explain' }],
          max_tokens: 256,
          tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object' } }],
        },
      }),
      reply
    );

    const forwarded = reply.__recorded.body as typeof fixture;
    expect(forwarded.content).toHaveLength(2);
    expect(forwarded.content[0].type).toBe('text');
    expect(forwarded.content[1].type).toBe('tool_use');
  });

  test('session JSON captures tool_use response with type discrimination', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('tool-use-response'), 200);

    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'use a tool' }],
          max_tokens: 256,
          tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object' } }],
        },
      }),
      buildMockReply()
    );

    const lastWrite = getLastSessionWrite();
    expect(lastWrite).not.toBeNull();
    const parsed = lastWrite!.parsed as {
      requests: Array<{ response: { stop_reason: string; id: string } }>;
    };
    const lastReq = parsed.requests[parsed.requests.length - 1];
    expect(lastReq.response.stop_reason).toBe('tool_use');
    expect(lastReq.response.id).toBe('msg_02DEF456tooluse');
  });
});
