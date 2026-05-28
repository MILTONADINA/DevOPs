// Test #6 — proxy-tenant-isolation. Q6 binding: multi-tenant SHAPE preserved,
// single-tenant ENFORCEMENT for v0.3.x. tenant_id defaults to "personal".
//
// Note: capture-session.ts at HEAD does NOT yet read STRATUM_DEFAULT_TENANT_ID
// or any X-Tenant-Id header. These tests assert the CURRENT state (no
// tenant_id field surfaced in capture artifact) and document the EXPECTED
// state once P0-E (Supabase storage backend) lands tenant_id wiring per Q6.
//
// This is honest scaffold-state testing: the proxy does not yet have the Q6
// wiring; we assert the absence of fabricated tenant_id behavior + add a
// xtest/test.todo marker for the wired-state behavior. P0-E will flip them
// to live assertions.

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

describe('proxy-tenant-isolation (Q6: multi-tenant SHAPE, single-tenant ENFORCEMENT)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('STRATUM_DEFAULT_TENANT_ID env is set to "personal" in test setup (Q6 default)', () => {
    expect(process.env.STRATUM_DEFAULT_TENANT_ID).toBe('personal');
  });

  test('current capture artifact does NOT yet surface tenant_id (P0-E wiring pending)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    // Honest assertion of the CURRENT scaffold: capture-session.ts at HEAD
    // doesn't read STRATUM_DEFAULT_TENANT_ID. Capturing this as a positive
    // assertion so the test inverts cleanly when P0-E lands.
    const parsed = getLastSessionWrite()!.parsed as Record<string, unknown>;
    expect(parsed.tenant_id).toBeUndefined();
  });

  test('X-Tenant-Id header is currently not forwarded to Anthropic body (correct: tenant is metadata, not request payload)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        headers: { 'x-tenant-id': 'tenant-alpha' },
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    // Negative invariant: the tenant value MUST NOT leak into the Anthropic
    // request body (that would be a real bug: tenant metadata is not
    // Anthropic-API-relevant; sending it would be a contract violation).
    const fwd = captureState.axios.postCalls[0].body;
    expect(JSON.stringify(fwd)).not.toContain('tenant-alpha');
  });

  test.todo('once P0-E wires tenant_id: default "personal" appears in capture artifact when no X-Tenant-Id header');

  test.todo('once P0-E wires tenant_id: X-Tenant-Id header value appears in capture artifact + propagates as OTel baggage (P0-G)');
});
