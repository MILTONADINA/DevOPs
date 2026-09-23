// Test #14 — oversized-payload (Session 15 §2a-4 AC-S15-2a-4.3)
//
// Adversarial tests for very-large request + response payloads. Covers:
//   (a) Request body >1MB (long user paste, large tool definitions)
//   (b) Response with very long content (10K+ tokens of text)
//   (c) Multi-turn session accumulating to multi-MB total
//
// Goal: confirm handler completes + capture write succeeds + redactor
// doesn't choke on size. Time-bound assertions catch performance regressions.

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import {
  captureState,
  getCaptureHandler,
  setAxiosResponse,
  resetMockState,
  getLastSessionWrite,
} from '../helpers/capture-harness';
import { resetAnthropicMock } from '../mocks/anthropic-sdk';
import { buildMockRequest, buildMockReply } from '../mocks/fastify-shapes';

beforeAll(async () => {
  await import('../../scripts/capture-session');
});

describe('oversized-payload (AC-S15-2a-4.3: large payload handling)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('request body 500KB (oversized) handled without crash', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse({
      id: 'msg_large_req',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'received' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 125_000, output_tokens: 5 },
    }, 200);

    // 500KB string: a long code paste or document quote scenario.
    // Typical Claude Code message is 1-20KB; 500KB is ~25-500x normal.
    // Larger values (>1MB) hit V8 worker memory ceilings in vitest pool;
    // 500KB exercises the same redactor + JSON.stringify + writeFileSync
    // path without crashing the test runner. See PB-23 for the worker
    // pool ceiling investigation.
    const largeText = 'x'.repeat(500_000);

    const t0 = Date.now();
    await expect(
      handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: largeText }], max_tokens: 8192 },
        }),
        buildMockReply()
      )
    ).resolves.not.toThrow();
    const elapsed = Date.now() - t0;

    // PB-24: an oversized leaf (>256KB) is now redacted WHOLESALE to a length-tagged placeholder
    // instead of scanned in full, so this is O(1) — far under the bound (it formerly measured
    // ~600-800ms scanning 500KB; the bound still catches a real perf regression on smaller inputs).
    expect(elapsed).toBeLessThan(1500);

    // The capture artifact write succeeded AND the 500KB body was redacted to the oversized
    // placeholder (PB-24: fail-closed — no raw megabyte content reaches disk, and no multi-second
    // event-loop block per turn). Previously this asserted the full 500KB survived intact.
    expect(captureState.fs.writes.length).toBeGreaterThan(0);
    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<{ request: { messages: Array<{ content: string }> } }>;
    };
    const captured = parsed.requests[parsed.requests.length - 1]!.request.messages[0]!.content;
    expect(captured).toBe('[REDACTED:oversized-500000]'); // PB-24: oversized → placeholder, not the raw 500KB
  });

  test('response with ~10K-token-equivalent text (40K chars) handled', async () => {
    const handler = getCaptureHandler();
    // ~40K characters ≈ 10K tokens on Anthropic's tokenizer for typical text
    const longResponse = ('The quick brown fox jumps over the lazy dog. ').repeat(900);
    setAxiosResponse({
      id: 'msg_long_resp',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: longResponse }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 50, output_tokens: 10_000 },
    }, 200);

    const t0 = Date.now();
    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'tell me a story' }], max_tokens: 12_000 },
      }),
      buildMockReply()
    );
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(5000);

    // Capture preserves the long response (length sanity check; not
    // asserting full content to keep the test result diff small)
    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<{ response: { content?: Array<{ type: string; text?: string }> } }>;
    };
    const last = parsed.requests[parsed.requests.length - 1];
    expect(last.response.content?.[0].text?.length).toBeGreaterThan(35_000);
  });

  test('multi-turn session accumulates without unbounded growth', async () => {
    const handler = getCaptureHandler();
    const mediumText = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(200);  // ~11KB

    // Run 10 turns; verify session JSON growth is roughly linear
    let firstWriteSize = 0;
    let lastWriteSize = 0;
    for (let i = 0; i < 10; i++) {
      setAxiosResponse({
        id: `msg_turn_${i}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: `Reply ${i}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 5 },
      }, 200);

      await handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: `Turn ${i}: ${mediumText}` }], max_tokens: 64 },
        }),
        buildMockReply()
      );

      const currentWriteSize = captureState.fs.writes[captureState.fs.writes.length - 1].data.length;
      if (i === 0) firstWriteSize = currentWriteSize;
      lastWriteSize = currentWriteSize;
    }

    // After 10 turns, size grew roughly linearly. Sanity: last write should
    // be at most ~15x the first (10 turns × per-turn growth + base session
    // overhead). Strict bound catches "session.requests grows quadratically"
    // bugs (e.g., copying the whole session into each turn).
    expect(lastWriteSize).toBeLessThan(firstWriteSize * 15);
    // And it should have grown (we accumulated 10 turns)
    expect(lastWriteSize).toBeGreaterThan(firstWriteSize);
  });

  test('massive tools[] array does not crash redactor or capture write', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse({
      id: 'msg_many_tools',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'received tools' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5000, output_tokens: 5 },
    }, 200);

    // 100 tool definitions; each with a JSON Schema description.
    // Real Claude Code can pass tens of tools per turn (MCP servers).
    const manyTools = Array.from({ length: 100 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool number ${i} — does some operation involving data and produces a result.`,
      input_schema: {
        type: 'object',
        properties: {
          arg1: { type: 'string', description: `First argument for tool ${i}` },
          arg2: { type: 'number', description: `Second argument for tool ${i}` },
        },
        required: ['arg1'],
      },
    }));

    const t0 = Date.now();
    await expect(
      handler(
        buildMockRequest({
          body: {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'use a tool' }],
            max_tokens: 64,
            tools: manyTools,
          },
        }),
        buildMockReply()
      )
    ).resolves.not.toThrow();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(5000);

    const parsed = getLastSessionWrite()!.parsed as {
      requests: Array<{ request: { tools?: unknown[] } }>;
    };
    const last = parsed.requests[parsed.requests.length - 1];
    expect(last.request.tools).toBeInstanceOf(Array);
    expect((last.request.tools as unknown[]).length).toBe(100);
  });
});
