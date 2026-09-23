import { describe, test, expect, beforeEach } from 'vitest';
import Anthropic, {
  setMockResponse,
  setMockError,
  resetAnthropicMock,
  loadMockResponse,
} from '../mocks/anthropic-sdk';
import { buildMockRequest, buildMockReply } from '../mocks/fastify-shapes';

describe('mocks-load smoke (P0-A scope guards)', () => {
  beforeEach(() => {
    resetAnthropicMock();
  });

  test('Anthropic client mock instantiates with required methods', () => {
    const client = new Anthropic({ apiKey: 'test' });
    expect(client.messages.create).toBeTypeOf('function');
    expect(client.messages.countTokens).toBeTypeOf('function');
    expect(client.messages.stream).toBeTypeOf('function');
  });

  test('Anthropic stream method explicitly throws (P0-A scope guard against P0-B drift)', () => {
    const client = new Anthropic({ apiKey: 'test' });
    expect(() => client.messages.stream({})).toThrow(/streaming not implemented in P0-A/i);
  });

  test('Anthropic create() also throws if stream:true (P0-A scope guard, second path)', async () => {
    const client = new Anthropic({ apiKey: 'test' });
    setMockResponse('simple-text-response');
    await expect(
      client.messages.create({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
        stream: true,
      })
    ).rejects.toThrow(/streaming not implemented in P0-A/i);
  });

  test('fastify mock builders instantiate with chainable reply', () => {
    const req = buildMockRequest({ method: 'POST', url: '/v1/messages' });
    const reply = buildMockReply();
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/messages');
    reply.code(200).header('content-type', 'application/json').send({ ok: true });
    expect(reply.__recorded.statusCode).toBe(200);
    expect(reply.__recorded.headers['content-type']).toBe('application/json');
    expect(reply.__recorded.body).toEqual({ ok: true });
    expect(reply.__recorded.sent).toBe(true);
  });

  test('fixture loader resolves all 6 P0-A response shapes', () => {
    const names = [
      'simple-text-response',
      'tool-use-response',
      'mixed-content-response',
      'multi-turn-response',
      'error-4xx-response',
      'error-5xx-response',
    ];
    for (const name of names) {
      // error responses don't load as Message-shape; they go through setMockError().
      // Use try/catch to allow either shape (the smoke test only confirms file presence).
      try {
        const r = loadMockResponse(name);
        expect(r).toBeDefined();
      } catch (e) {
        // OK: error-shaped fixtures don't parse as Message; smoke confirms file exists.
        expect((e as Error).message).not.toMatch(/Mock fixture not found/);
      }
    }
  });
});
