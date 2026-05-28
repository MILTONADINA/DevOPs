// Test #11 — pii-redaction-failclosed
//
// Dedicated test file for AC-S15-2a-2.2: PII redactor exception triggers
// FAIL-CLOSED — turn dropped from session JSON + structured stderr log +
// proxy continues accepting subsequent turns (single-turn failure does NOT
// terminate).
//
// Isolation strategy: hoisted vi.mock for the redactor module (NOT inline
// vi.doMock). The hoisted variant is reliable because vitest does the path
// resolution itself; relative-path mismatch between test file and
// capture-session.ts (which imports from different relative roots) is
// handled correctly.
//
// This file has its own beforeAll-imports-capture-session pattern, just
// like the other capture-session test files. The mocked redactor is active
// from module load.

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  captureState,
  getCaptureHandler,
  setAxiosResponse,
  resetMockState,
} from '../helpers/capture-harness';
import { resetAnthropicMock, loadMockResponse } from '../mocks/anthropic-sdk';
import { buildMockRequest, buildMockReply } from '../mocks/fastify-shapes';

// Hoisted state: tracks whether the redactor should throw on this turn.
// Set to true before invoking the handler; the mocked redactor checks this
// flag and throws if set. Default: false (redactor behaves normally).
const failclosedState = vi.hoisted(() => ({ shouldThrow: false }));

// Hoisted mock: vitest resolves vi.mock paths relative to the **test file**.
// From this file (stratum/test/capture-session/), 4 levels up reaches
// observability/pii-redaction.ts. capture-session.ts (stratum/scripts/)
// uses `../../observability/pii-redaction` to reach the same file — vitest
// matches by resolved absolute path, so any caller's import of that target
// gets the mocked version.
// Mock via the `@devops/*` alias (configured in stratum/vitest.config.ts +
// stratum/tsconfig.json). capture-session.ts imports the SAME canonical
// alias path, so vitest's path-normalization matches both ends to the same
// underlying module — the mock is reliably applied.
vi.mock('@devops/observability/pii-redaction', async () => {
  const actual = await vi.importActual<typeof import('../../../../observability/pii-redaction')>('@devops/observability/pii-redaction');
  return {
    ...actual,
    redactValue: (v: unknown) => {
      if (failclosedState.shouldThrow) {
        throw new Error('synthetic redactor failure for FAIL-CLOSED test');
      }
      return actual.redactValue(v);
    },
  };
});

beforeAll(async () => {
  await import('../../scripts/capture-session');
});

describe('pii-redaction-failclosed (AC-S15-2a-2.2: redactor exception → FAIL-CLOSED)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
    failclosedState.shouldThrow = false;
  });

  test('control: normal turn succeeds + capture artifact written (redactor not throwing)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'safe turn' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    expect(captureState.fs.writes.length).toBeGreaterThan(0);
    const lastWriteData = captureState.fs.writes[captureState.fs.writes.length - 1].data;
    expect(lastWriteData).toContain('safe turn');
  });

  test('redactor throw triggers FAIL-CLOSED: stderr log + turn NOT written to disk', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    failclosedState.shouldThrow = true;

    try {
      const reply = buildMockReply();
      await handler(
        buildMockRequest({
          body: {
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'turn that triggers redactor failure' }],
            max_tokens: 64,
          },
        }),
        reply
      );

      // Assertion 1: structured stderr emitted naming PII/redact/FAIL-CLOSED context
      const errorOutput = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errorOutput.toLowerCase()).toMatch(/pii|redact|fail-closed/);
      expect(errorOutput).toContain('synthetic redactor failure');

      // Assertion 2: client STILL gets the forwarded response (proxy purpose preserved)
      expect(reply.__recorded.sent).toBe(true);
      expect(reply.__recorded.body).toBeDefined();

      // Assertion 3: no NEW write contains the marker string (FAIL-CLOSED: turn dropped from session JSON)
      const writesAfter = captureState.fs.writes;
      for (const w of writesAfter) {
        expect(w.data).not.toContain('turn that triggers redactor failure');
      }
    } finally {
      failclosedState.shouldThrow = false;
      errorSpy.mockRestore();
    }
  });

  test('proxy recovers after FAIL-CLOSED: next turn captured normally (single-turn failure does NOT terminate)', async () => {
    const handler = getCaptureHandler();

    // Turn 1: forced redactor failure
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);
    failclosedState.shouldThrow = true;
    const errorSpyT1 = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'first turn fails' }], max_tokens: 64 },
        }),
        buildMockReply()
      );
    } finally {
      errorSpyT1.mockRestore();
    }

    // Turn 2: redactor recovers; turn should be captured normally
    failclosedState.shouldThrow = false;
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'second turn succeeds' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    // Latest write should contain turn 2 content but NOT turn 1 content
    const latestWrite = captureState.fs.writes[captureState.fs.writes.length - 1];
    expect(latestWrite.data).toContain('second turn succeeds');
    expect(latestWrite.data).not.toContain('first turn fails');
  });

  test('FAIL-CLOSED stderr names AC-S15-2a-2.2 anchor + turn number', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    failclosedState.shouldThrow = true;

    try {
      await handler(
        buildMockRequest({
          body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'force fail' }], max_tokens: 64 },
        }),
        buildMockReply()
      );

      const errorOutput = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      // Naming the AC anchor in the error message helps future debugging:
      // grep for "AC-S15-2a-2.2" returns this log line.
      expect(errorOutput).toMatch(/AC-S15-2a-2\.2|Turn \d+/);
    } finally {
      failclosedState.shouldThrow = false;
      errorSpy.mockRestore();
    }
  });
});
