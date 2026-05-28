// Test #5 — proxy-error-handling. Verifies Anthropic 4xx/5xx forwarding,
// network errors, and malformed-response handling per spec §2 item 8.

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import {
  captureState,
  getCaptureHandler,
  setAxiosResponse,
  setAxiosError,
  setAxiosErrorWithResponse,
  resetMockState,
} from '../helpers/capture-harness';
import { resetAnthropicMock, loadMockResponse, loadMockError } from '../mocks/anthropic-sdk';
import { buildMockRequest, buildMockReply } from '../mocks/fastify-shapes';

beforeAll(async () => {
  await import('../../scripts/capture-session');
});

describe('proxy-error-handling', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('Anthropic 4xx response forwarded with same status + body', async () => {
    const handler = getCaptureHandler();
    const errFixture = loadMockError('error-4xx-response');
    setAxiosErrorWithResponse(400, errFixture);

    const reply = buildMockReply();
    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [], max_tokens: 64 },  // empty messages triggers 400
      }),
      reply
    );

    expect(reply.__recorded.statusCode).toBe(400);
    expect(reply.__recorded.body).toEqual(errFixture);
    expect(reply.__recorded.sent).toBe(true);
  });

  test('Anthropic 5xx (overloaded) response forwarded with status 503', async () => {
    const handler = getCaptureHandler();
    const errFixture = loadMockError('error-5xx-response');
    setAxiosErrorWithResponse(503, errFixture);

    const reply = buildMockReply();
    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 },
      }),
      reply
    );

    expect(reply.__recorded.statusCode).toBe(503);
    expect(reply.__recorded.body).toEqual(errFixture);
  });

  test('network error (no axios .response) propagates as an exception', async () => {
    const handler = getCaptureHandler();
    setAxiosError(new Error('ECONNRESET: connection reset by peer'));

    await expect(
      handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 },
        }),
        buildMockReply()
      )
    ).rejects.toThrow(/ECONNRESET/);
  });

  test('Anthropic 4xx error response is NOT captured to session JSON requests array', async () => {
    const handler = getCaptureHandler();
    const errFixture = loadMockError('error-4xx-response');
    setAxiosErrorWithResponse(400, errFixture);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    // capture-session.ts returns early on axios errors with .response, before pushing to session.requests
    // The session file may exist from earlier turns; check the latest write doesn't include this errored turn
    const writeCount = captureState.fs.writes.length;
    // Either no write occurred for this turn, OR the write happened pre-error (session start)
    // The negative invariant: the errored request body shouldn't appear in the last write's requests array
    if (writeCount > 0) {
      const lastWrite = captureState.fs.writes[writeCount - 1];
      const parsed = JSON.parse(lastWrite.data) as { requests: Array<{ request: { messages: Array<{ content: string }> } }> };
      const erroredTurn = parsed.requests.find(r =>
        r.request.messages.some(m => m.content === 'x')
      );
      expect(erroredTurn).toBeUndefined();
    }
  });

  test('successful request after a 4xx still works (state not corrupted by error path)', async () => {
    const handler = getCaptureHandler();

    // First request: 4xx
    setAxiosErrorWithResponse(400, loadMockError('error-4xx-response'));
    await handler(
      buildMockRequest({ body: { model: 'claude-opus-4-7', messages: [], max_tokens: 64 } }),
      buildMockReply()
    );

    // Second request: success
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);
    const reply = buildMockReply();
    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'recover' }],
          max_tokens: 64,
        },
      }),
      reply
    );

    expect(reply.__recorded.body).toBeDefined();
    expect((reply.__recorded.body as { id: string }).id).toBe('msg_01ABC123simple');
  });
});
