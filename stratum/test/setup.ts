// stratum/test/setup.ts — vitest config setupFiles entry.
//
// Two responsibilities:
//   1) Env defaults per Q4/Q6/Q7 §7 resolutions
//   2) Module mocks for the hermetic capture-session.ts harness
//
// vi.mock() calls here are hoisted per-test-file by vitest. The shared
// recorded state lives in test/helpers/capture-harness.ts.

import { beforeAll, vi } from 'vitest';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.ANTHROPIC_BASE_URL = 'http://localhost:0/mock';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
  process.env.ANTHROPIC_API_KEY = 'test-sk-mock';
  process.env.STRATUM_DEFAULT_TENANT_ID = 'personal';
});

// ===== fastify mock =====
// Captures route registrations + suppresses port binding.
vi.mock('fastify', async () => {
  const { captureState } = await import('./helpers/capture-harness');
  return {
    default: () => {
      const instance: Record<string, unknown> = {
        post(p: string, h: (req: unknown, reply: unknown) => Promise<unknown>) {
          captureState.fastify.routes.push({ method: 'POST', path: p, handler: h as never });
          return instance;
        },
        get(p: string, h: (req: unknown, reply: unknown) => Promise<unknown>) {
          captureState.fastify.routes.push({ method: 'GET', path: p, handler: h as never });
          return instance;
        },
        listen(opts: { port: number; host: string }, cb?: (err: Error | null) => void) {
          captureState.fastify.listenCalls.push(opts);
          if (cb) queueMicrotask(() => cb(null));
          return Promise.resolve(`http://${opts.host}:${opts.port}`);
        },
        close() { return Promise.resolve(); },
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      };
      return instance;
    },
  };
});

// ===== @anthropic-ai/sdk mock =====
vi.mock('@anthropic-ai/sdk', async () => {
  const sdkMock = await import('./mocks/anthropic-sdk');
  return { default: sdkMock.default };
});

// ===== axios mock =====
// Records POST calls; configurable per-test response/error via captureState.
vi.mock('axios', async () => {
  const { captureState } = await import('./helpers/capture-harness');
  return {
    default: {
      post: vi.fn(async (url: string, body: unknown, config: unknown) => {
        captureState.axios.postCalls.push({
          url,
          body,
          config: config as { headers: Record<string, string> },
        });
        if (captureState.axios.nextError) throw captureState.axios.nextError;
        if (!captureState.axios.nextResponse) {
          throw new Error(
            'axios mock has no response configured — test must call setAxiosResponse() or setAxiosError() in beforeEach'
          );
        }
        return captureState.axios.nextResponse;
      }),
    },
  };
});

// ===== fs mock ('fs' + 'node:fs' both) =====
// capture-session.ts uses `import fs from "fs"` (default). Mock both
// specifiers with identical factories.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const { captureState } = await import('./helpers/capture-harness');
  const wrapped = {
    ...actual,
    mkdirSync: vi.fn(() => undefined),
    writeFileSync: vi.fn((p: string, d: string) => {
      captureState.fs.writes.push({ path: p, data: d });
    }),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const { captureState } = await import('./helpers/capture-harness');
  const wrapped = {
    ...actual,
    mkdirSync: vi.fn(() => undefined),
    writeFileSync: vi.fn((p: string, d: string) => {
      captureState.fs.writes.push({ path: p, data: d });
    }),
  };
  return { ...wrapped, default: wrapped };
});

// ===== dotenv mock (no-op; env set above) =====
vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }));
