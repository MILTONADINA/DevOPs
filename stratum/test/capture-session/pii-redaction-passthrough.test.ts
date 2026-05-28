// Test #10 — pii-redaction-passthrough (STRUCTURAL ONLY).
//
// Scope guard: this file asserts the consumption-contract structure —
// capture-session.ts should consume DevOPs's `observability/pii-redaction.ts`
// module rather than re-implement redaction logic inline. Behavioral
// PII redaction tests (which patterns redact, edge cases, false-positive
// bounds) live in P0-F (Session 15+) once the consumption is actually
// wired.
//
// Current state of capture-session.ts: PII redaction is NOT yet consumed.
// This file's assertions capture (a) the current absence honestly, and
// (b) the future-wired-state expectations as test.todo markers so P0-F
// inverts them cleanly. This is honest scaffold-state testing — NOT
// fabrication of redaction behavior.

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCaptureHandler,
  setAxiosResponse,
  resetMockState,
  getLastSessionWrite,
} from '../helpers/capture-harness';
import { resetAnthropicMock, loadMockResponse } from '../mocks/anthropic-sdk';
import { buildMockRequest, buildMockReply } from '../mocks/fastify-shapes';

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve to the DevOPs root (../../stratum/test/capture-session → DevOPs)
const devopsRoot = path.resolve(here, '../../..');

beforeAll(async () => {
  await import('../../scripts/capture-session');
});

describe('pii-redaction-passthrough (P0-F consumption contract; structural-only)', () => {
  beforeEach(() => {
    resetAnthropicMock();
    resetMockState();
  });

  test('DevOPs observability/pii-redaction.ts source-of-truth exists at expected path', () => {
    const piiPath = path.join(devopsRoot, 'observability', 'pii-redaction.ts');
    expect(existsSync(piiPath)).toBe(true);
  });

  test('DevOPs pii-redaction.ts exports the redacting function (P0-F consumption target)', () => {
    const piiPath = path.join(devopsRoot, 'observability', 'pii-redaction.ts');
    const source = readFileSync(piiPath, 'utf-8');
    // The DevOPs source currently exports `piiRedactingExporter` (an OTel-
    // exporter wrapper). P0-F may consume that directly or extract a pure
    // `redact(text)` helper. Match either shape so this test is forward-
    // compatible with whatever export surface P0-F uses.
    const hasExport =
      /export\s+(function|const|async function)\s+\w*[Rr]edact\w*/.test(source) ||
      /export\s+(function|const|async function)\s+pii\w*/.test(source) ||
      /export\s*\{[^}]*\b\w*[Rr]edact\w*\b[^}]*\}/.test(source);
    expect(hasExport).toBe(true);
  });

  test('capture-session.ts at HEAD does NOT yet import from observability/pii-redaction.ts (P0-F pending)', () => {
    const captureSessionPath = path.join(devopsRoot, 'stratum', 'scripts', 'capture-session.ts');
    const source = readFileSync(captureSessionPath, 'utf-8');
    // Honest current-state assertion: when P0-F lands, this assertion
    // INVERTS (the import IS added). The test file's intent is to surface
    // the consumption-contract status, not to fabricate compliance.
    expect(source).not.toMatch(/import[\s\S]{0,200}observability\/pii-redaction/);
  });

  test('capture-session.ts at HEAD does NOT contain inline PII regex patterns (negative invariant: no duplication)', () => {
    const captureSessionPath = path.join(devopsRoot, 'stratum', 'scripts', 'capture-session.ts');
    const source = readFileSync(captureSessionPath, 'utf-8');
    // Pattern markers from the 8 patterns in observability/pii-redaction.ts:
    // email, phone-us, ssn, cc, jwt, bearer, sk-key, aws-key.
    // None of these patterns should appear inline (Stratum CONSUMES, never
    // duplicates). The negative invariant guards against P0-F drift.
    const inlineRedactionMarkers = [
      /REDACTED-email/,
      /REDACTED-jwt/,
      /REDACTED-bearer/,
      /AKIA\[A-Z0-9\]/,    // AWS key regex marker
      /sk-\\w\{40\}/,      // sk-key regex marker
    ];
    for (const marker of inlineRedactionMarkers) {
      expect(source).not.toMatch(marker);
    }
  });

  test('current capture artifact contains raw request body (P0-F redaction not yet wired — honesty)', async () => {
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    const plantedEmail = 'planted-pii@example.com';
    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: `My email is ${plantedEmail}` }],
          max_tokens: 64,
        },
      }),
      buildMockReply()
    );

    const lastWrite = getLastSessionWrite()!;
    const parsedRaw = JSON.stringify(lastWrite.parsed);
    // Current state: the email appears in the capture artifact because
    // P0-F redaction isn't wired yet. This is the "before" state; P0-F
    // will invert this assertion.
    expect(parsedRaw).toContain(plantedEmail);
  });

  test.todo('once P0-F wires consumption: planted email is replaced with [REDACTED-email] in capture artifact');

  test.todo('once P0-F wires consumption: planted JWT in response.content[].text is [REDACTED-jwt] in capture artifact');

  test.todo('once P0-F wires consumption: PII redactor exception triggers FAIL-CLOSED (drop turn from session, emit pii.redaction_failed OTel event)');
});
