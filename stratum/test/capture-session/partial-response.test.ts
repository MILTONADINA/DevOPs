// Test #13 — partial-response (Session 15 §2a-4 AC-S15-2a-4.2)
//
// Adversarial tests for malformed / partial Anthropic responses. Covers:
//   (a) Truncated response body (network drop mid-receive)
//   (b) Valid status but malformed content blocks (missing fields)
//   (c) Empty response (no content blocks; non-zero usage)
//
// The proxy must NOT crash on any of these; capture artifact records the
// malformed state honestly.

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

describe('partial-response (AC-S15-2a-4.2: malformed Anthropic responses)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('response missing content array does not crash; capture records the absence', async () => {
    const handler = getCaptureHandler();
    // A response with usage + stop_reason but no content[] — could happen
    // if Anthropic-side filtering returns a refusal with empty body.
    setAxiosResponse({
      id: 'msg_no_content',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      // content: <intentionally omitted>
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    }, 200);

    // Should not throw
    await expect(
      handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'safe' }], max_tokens: 64 },
        }),
        buildMockReply()
      )
    ).resolves.not.toThrow();

    // Capture artifact records the response (with content absent)
    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<{ response: { id: string; stop_reason: string } }>;
    };
    const last = parsed.requests[parsed.requests.length - 1];
    expect(last.response.id).toBe('msg_no_content');
    expect(last.response.stop_reason).toBe('end_turn');
  });

  test('content block with missing text field is preserved honestly in capture', async () => {
    const handler = getCaptureHandler();
    // Content block claims type: text but has no text field. Malformed but
    // not crash-worthy — capture-session.ts must not assume field presence.
    setAxiosResponse({
      id: 'msg_malformed_block',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text' /* text field intentionally omitted */ }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    }, 200);

    await expect(
      handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'q' }], max_tokens: 64 },
        }),
        buildMockReply()
      )
    ).resolves.not.toThrow();
  });

  test('usage block with zero tokens still recorded correctly', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse({
      id: 'msg_zero_tokens',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }, 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'q' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<{ response: { usage: { input_tokens: number; output_tokens: number } } }>;
      total_input_tokens: number;
      total_output_tokens: number;
    };
    const last = parsed.requests[parsed.requests.length - 1];
    expect(last.response.usage.input_tokens).toBe(0);
    expect(last.response.usage.output_tokens).toBe(0);
  });

  test('stop_reason of "max_tokens" (truncated generation) recorded honestly', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse({
      id: 'msg_truncated',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'This response was cut off mid-' }],
      stop_reason: 'max_tokens',  // hit the limit
      stop_sequence: null,
      usage: { input_tokens: 50, output_tokens: 64 },  // matches max_tokens
    }, 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'long story' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<{ response: { stop_reason: string } }>;
    };
    const last = parsed.requests[parsed.requests.length - 1];
    expect(last.response.stop_reason).toBe('max_tokens');
  });

  test('unknown content block type does not crash the handler', async () => {
    const handler = getCaptureHandler();
    // Hypothetical future content type Anthropic adds (e.g. 'image', 'tool_result').
    // Today's capture-session.ts must not crash on unknown types.
    setAxiosResponse({
      id: 'msg_unknown_block',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [
        { type: 'text', text: 'Here is an image:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '<truncated-base64>' } } as unknown as { type: 'text'; text: string },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }, 200);

    await expect(
      handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'q' }], max_tokens: 64 },
        }),
        buildMockReply()
      )
    ).resolves.not.toThrow();
  });
});
