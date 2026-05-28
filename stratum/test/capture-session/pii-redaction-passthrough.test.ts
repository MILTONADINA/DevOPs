// Test #10 — pii-redaction-passthrough.
//
// Session 15 §2a-2: P0-F PII redaction wiring is now LIVE (per AC-S15-2a-2.1
// through AC-S15-2a-2.4). This file asserts both:
//   (a) Consumption-contract structure — capture-session.ts imports from
//       DevOPs's observability/pii-redaction.ts (not duplicated patterns)
//   (b) Behavioral redaction — planted PII (email, JWT) is redacted in
//       capture artifacts; non-PII metadata preserved; FAIL-CLOSED on
//       redactor exception (turn dropped + stderr log)

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureState,
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

  test('capture-session.ts imports from observability/pii-redaction (P0-F wired Session 15 §2a-2 — AC-S15-2a-2.4)', () => {
    const captureSessionPath = path.join(devopsRoot, 'stratum', 'scripts', 'capture-session.ts');
    const source = readFileSync(captureSessionPath, 'utf-8');
    // Post-wiring assertion: the import is now present. Single source of
    // truth for redaction patterns per spec §3 P0-F (Stratum CONSUMES,
    // does NOT duplicate).
    expect(source).toMatch(/import[\s\S]{0,200}observability\/pii-redaction/);
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

  test('planted email is redacted to [REDACTED:email] in capture artifact (P0-F wired Session 15 §2a-2)', async () => {
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
    // Post-wiring assertion: the raw email MUST NOT appear in the capture
    // artifact; the redactor pattern places `[REDACTED:email]` instead.
    // Verbatim per observability/pii-redaction.ts redactString output format.
    expect(parsedRaw).not.toContain(plantedEmail);
    expect(parsedRaw).toContain('[REDACTED:email]');
  });

  test('planted JWT in response.content[].text is redacted to [REDACTED:jwt] (AC-S15-2a-2.1)', async () => {
    const handler = getCaptureHandler();
    // Construct a response fixture in-test with a JWT in content[].text
    const plantedJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    setAxiosResponse({
      id: 'msg_jwt_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: `Here is your token: ${plantedJwt}. Use it carefully.` }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 30 },
    }, 200);

    await handler(
      buildMockRequest({
        body: {
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'gimme a token' }],
          max_tokens: 64,
        },
      }),
      buildMockReply()
    );

    const lastWrite = getLastSessionWrite()!;
    const parsedRaw = JSON.stringify(lastWrite.parsed);
    expect(parsedRaw).not.toContain(plantedJwt);
    expect(parsedRaw).toContain('[REDACTED:jwt]');
  });

  test('non-PII metadata preserved through redaction (AC-S15-2a-2.3)', async () => {
    // model, stop_reason, usage.input_tokens etc. must NOT be redacted.
    const handler = getCaptureHandler();
    setAxiosResponse(loadMockResponse('simple-text-response'), 200);

    await handler(
      buildMockRequest({
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'safe content' }], max_tokens: 64 },
      }),
      buildMockReply()
    );

    const lastWrite = getLastSessionWrite()!;
    const parsed = lastWrite.parsed as {
      requests: Array<{
        request: { model: string; max_tokens: number };
        response: { id: string; stop_reason: string; usage: { input_tokens: number; output_tokens: number } };
        token_counts: { input_tokens: number };
      }>;
    };
    const last = parsed.requests[parsed.requests.length - 1];
    expect(last.request.model).toBe('claude-opus-4-7');
    expect(last.request.max_tokens).toBe(64);
    expect(last.response.id).toBe('msg_01ABC123simple');
    expect(last.response.stop_reason).toBe('end_turn');
    expect(last.response.usage.input_tokens).toBe(12);
    expect(last.response.usage.output_tokens).toBe(8);
  });

  // AC-S15-2a-2.2 FAIL-CLOSED behavior is tested in a dedicated file
  // (test/capture-session/pii-redaction-failclosed.test.ts) using hoisted
  // vi.mock for clean module-mock isolation. The vi.doMock + vi.resetModules
  // dance inside this file produced unreliable results due to relative-path
  // resolution mismatch between test-file and capture-session imports, and
  // double-handler-registration on resetModules. Hoisted vi.mock in a
  // dedicated file avoids both issues.
});
