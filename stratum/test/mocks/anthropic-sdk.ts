// stratum/test/mocks/anthropic-sdk.ts
//
// Test mock for @anthropic-ai/sdk. Production-grade scope guards:
//   - messages.create(): configurable from fixture loader
//   - messages.countTokens(): per-turn live per Q2 (heuristic-deterministic)
//   - messages.stream(): EXPLICITLY THROWS — streaming is P0-B (Session 14+),
//     not P0-A scope. Any test attempting to invoke this is reaching past
//     the P0-A scope guard and the throw surfaces that immediately.
//
// Used via vi.mock('@anthropic-ai/sdk', () => import('../mocks/anthropic-sdk'))
// in test files. Each test configures the next mock response via
// setMockResponse(name) or setMockError(name).

import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '../fixtures/anthropic');

export interface MockMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: string;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface MockError {
  status: number;
  type: 'error';
  error: { type: string; message: string };
}

interface CountTokensCall {
  model: string;
  messages: unknown[];
  system?: string;
  tools?: unknown[];
}

interface CreateCall {
  model: string;
  messages: unknown[];
  system?: string;
  tools?: unknown[];
  max_tokens: number;
  stream?: boolean;
}

// Per-test mutable state. Tests reset via resetAnthropicMock() in beforeEach.
let nextResponse: MockMessage | null = null;
let nextError: MockError | null = null;
let nextNetworkError: Error | null = null;
const createCalls: CreateCall[] = [];
const countTokensCalls: CountTokensCall[] = [];

export function loadMockResponse(name: string): MockMessage {
  const file = path.join(fixturesDir, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`Mock fixture not found: ${file}`);
  }
  return JSON.parse(readFileSync(file, 'utf-8')) as MockMessage;
}

export function loadMockError(name: string): MockError {
  const file = path.join(fixturesDir, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`Mock error fixture not found: ${file}`);
  }
  const body = JSON.parse(readFileSync(file, 'utf-8')) as { type: string; error: { type: string; message: string } };
  // 4xx vs 5xx: pick status by fixture name convention
  const status = name.includes('5xx') ? 503 : 400;
  return { status, ...body } as MockError;
}

export function setMockResponse(name: string): void {
  nextResponse = loadMockResponse(name);
  nextError = null;
  nextNetworkError = null;
}

export function setMockError(name: string): void {
  nextError = loadMockError(name);
  nextResponse = null;
  nextNetworkError = null;
}

export function setMockNetworkError(message = 'ECONNRESET'): void {
  nextNetworkError = new Error(message);
  nextResponse = null;
  nextError = null;
}

export function getCreateCalls(): readonly CreateCall[] {
  return createCalls;
}

export function getCountTokensCalls(): readonly CountTokensCall[] {
  return countTokensCalls;
}

export function resetAnthropicMock(): void {
  nextResponse = null;
  nextError = null;
  nextNetworkError = null;
  createCalls.length = 0;
  countTokensCalls.length = 0;
}

class MockAnthropicError extends Error {
  status: number;
  type: 'error';
  error: { type: string; message: string };
  constructor(payload: MockError) {
    super(payload.error.message);
    this.status = payload.status;
    this.type = 'error';
    this.error = payload.error;
    this.name = 'MockAnthropicError';
  }
}

class Messages {
  async create(params: CreateCall): Promise<MockMessage> {
    createCalls.push(params);
    if (params.stream === true) {
      throw new Error(
        'streaming not implemented in P0-A mocks; streaming tests live in P0-B coverage (Session 14+). ' +
        'See .workflow/state/plans/stratum-phase-0-capture.md §3 P0-B re-scope.'
      );
    }
    if (nextNetworkError) {
      const err = nextNetworkError;
      throw err;
    }
    if (nextError) {
      throw new MockAnthropicError(nextError);
    }
    if (!nextResponse) {
      throw new Error('No mock response configured. Call setMockResponse() or setMockError() before invoking the proxy.');
    }
    return nextResponse;
  }

  stream(_params: unknown): never {
    throw new Error(
      'streaming not implemented in P0-A mocks; streaming tests live in P0-B coverage (Session 14+). ' +
      'See .workflow/state/plans/stratum-phase-0-capture.md §3 P0-B re-scope.'
    );
  }

  async countTokens(params: CountTokensCall): Promise<{ input_tokens: number }> {
    countTokensCalls.push(params);
    // Deterministic heuristic — production-grade enough for assertions about
    // input-token recording (Q2). Real countTokens is invoked in CI / live.
    const serialized = JSON.stringify({
      model: params.model,
      messages: params.messages,
      system: params.system,
      tools: params.tools,
    });
    return { input_tokens: Math.floor(serialized.length / 4) };
  }
}

export default class Anthropic {
  apiKey: string;
  baseURL?: string;
  messages: Messages;

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    if (!opts.apiKey) {
      throw new Error('Anthropic client requires apiKey');
    }
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.messages = new Messages();
  }
}

// Mirror the real SDK's named exports surface (MessageParam etc. are types only;
// tests don't need them at runtime). Provide a getter so `import { Anthropic }`
// from the mock works just as `import Anthropic from '@anthropic-ai/sdk'` does.
export { Anthropic };
