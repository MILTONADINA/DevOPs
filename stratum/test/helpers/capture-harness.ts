// stratum/test/helpers/capture-harness.ts
//
// Shared state + helpers for capture-session.ts hermetic testing.
//
// Each test file declares its own vi.mock() calls (vitest hoisting requires
// top-of-file placement). Those factories all `await import()` THIS module
// to read/write the singleton state below. That gives us deduplication of
// the recorded-state shape + helper functions without breaking hoisting.
//
// SCOPE COMPLIANCE: zero modifications to scripts/capture-session.ts.

import type { FastifyRequest, FastifyReply } from 'fastify';

export type CaptureHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

interface AxiosConfig { headers: Record<string, string> }

export const captureState = {
  fastify: {
    routes: [] as Array<{ method: string; path: string; handler: CaptureHandler }>,
    listenCalls: [] as Array<{ port: number; host: string }>,
  },
  axios: {
    postCalls: [] as Array<{ url: string; body: unknown; config: AxiosConfig }>,
    nextResponse: null as { status: number; data: unknown } | null,
    nextError: null as Error | null,
  },
  fs: {
    writes: [] as Array<{ path: string; data: string }>,
    stderrLogs: [] as string[],
  },
};

export function getCaptureHandler(): CaptureHandler {
  const route = captureState.fastify.routes.find(
    r => r.method === 'POST' && r.path === '/v1/messages'
  );
  if (!route) {
    throw new Error(
      'POST /v1/messages handler not registered — check capture-session.ts module-load order'
    );
  }
  return route.handler;
}

export function setAxiosResponse(data: unknown, status = 200): void {
  captureState.axios.nextResponse = { status, data };
  captureState.axios.nextError = null;
}

export function setAxiosError(err: Error): void {
  captureState.axios.nextError = err;
  captureState.axios.nextResponse = null;
}

export function setAxiosErrorWithResponse(status: number, data: unknown): void {
  // Simulate axios's behavior on HTTP error responses: it throws with `response`
  // populated. capture-session.ts's catch block checks for `axiosError.response`
  // and forwards the status + body.
  const err = new Error(`Request failed with status ${status}`) as Error & { response?: unknown };
  err.response = { status, data };
  captureState.axios.nextError = err;
  captureState.axios.nextResponse = null;
}

export function resetMockState(): void {
  captureState.axios.postCalls.length = 0;
  captureState.axios.nextResponse = null;
  captureState.axios.nextError = null;
  captureState.fs.writes.length = 0;
  captureState.fs.stderrLogs.length = 0;
  // fastify.routes persists across tests within a worker (capture-session.ts
  // registers it once at module-load); only listenCalls would reset across
  // worker boundaries, which is fine.
}

export function getLastSessionWrite(): { path: string; parsed: { [key: string]: unknown } } | null {
  const writes = captureState.fs.writes;
  if (writes.length === 0) return null;
  const last = writes[writes.length - 1];
  return { path: last.path, parsed: JSON.parse(last.data) };
}
