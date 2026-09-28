/**
 * Live-API smoke test (MANUAL — spends a tiny bit of real API credit).
 *
 * Sends ONE minimal /v1/messages request THROUGH the proxy to the REAL Anthropic
 * API and verifies the live path the mocked unit tests can't: real forward →
 * real upstream 200 → exact token count (SDK countTokens) → FAIL-CLOSED capture
 * artifact on disk. Uses Haiku + max_tokens:16 to keep cost negligible.
 *
 * NOT a vitest test + NOT in CI (it makes a paid network call). Run on demand:
 *   ANTHROPIC_API_KEY=... npm run smoke:live
 * Gated: if no key is set, it prints how to run and exits 0 (not a failure).
 */

import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { buildProxy } from "../src/proxy/app";
import {
  resolveAnthropicBaseUrl,
  forwardToAnthropic,
  type MessagesBody,
  type MessagesDeps,
} from "../src/proxy/forward";
import { withRetry } from "../src/proxy/retry";
import { createTokenCounter } from "../src/proxy/token-count";
import { forwardStreamToAnthropic } from "../src/proxy/stream-forward";
import { createCaptureStore, type CaptureSession } from "../src/proxy/capture";
import { readSessionsFromDir } from "../src/proxy/routes/dashboard";
import { getAnthropicClient } from "../src/lib/anthropic";

const MODEL = process.env["SMOKE_MODEL"] ?? "claude-haiku-4-5-20251001";

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    out("Live smoke test GATED: set ANTHROPIC_API_KEY to run.");
    out("  ANTHROPIC_API_KEY=sk-ant-... npm run smoke:live");
    out("Exiting 0 (gated, not a failure).");
    return 0;
  }

  const baseUrl = resolveAnthropicBaseUrl();
  const client = getAnthropicClient();
  const sessionId = `smoke-${randomUUID()}`;
  const dir = join(process.cwd(), "data", "sessions");
  mkdirSync(dir, { recursive: true });
  const outFile = join(dir, `${sessionId}.json`);

  const counter = createTokenCounter(client);
  const deps: MessagesDeps = {
    apiKey,
    forward: withRetry((b, k) => forwardToAnthropic(b, k, baseUrl)),
    forwardStream: (b, k) => forwardStreamToAnthropic(b, k, baseUrl),
    countTokens: (b) => counter.count(b),
    capture: createCaptureStore({ sessionId, outputFile: outFile }),
  };
  const app = buildProxy({
    messages: deps,
    dashboard: { readSessions: () => readSessionsFromDir(dir) },
  });

  const body: MessagesBody = {
    model: MODEL,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
  };

  out(`→ POST /v1/messages through proxy (model=${MODEL}, base=${baseUrl})`);
  const res = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  await app.close();

  const checks: { name: string; ok: boolean; detail: string }[] = [];
  checks.push({ name: "HTTP 200 from upstream", ok: res.statusCode === 200, detail: `status=${res.statusCode}` });

  let replyText = "";
  let responseUsage: unknown;
  try {
    const parsed = JSON.parse(res.body) as { content?: { type: string; text?: string }[]; usage?: unknown };
    replyText = (parsed.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ").trim();
    responseUsage = parsed.usage;
  } catch {
    /* leave replyText empty → the check below fails */
  }
  checks.push({ name: "response has text content", ok: replyText.length > 0, detail: `reply="${replyText.slice(0, 40)}"` });
  checks.push({ name: "upstream usage present", ok: Boolean(responseUsage), detail: JSON.stringify(responseUsage) });

  let session: CaptureSession | undefined;
  try {
    session = JSON.parse(readFileSync(outFile, "utf8")) as CaptureSession;
  } catch {
    /* leave undefined → checks below fail */
  }
  const turn0 = session?.requests[0];
  checks.push({ name: "capture artifact written (1 turn)", ok: session?.total_turns === 1 && session.requests.length === 1, detail: `turns=${session?.total_turns}` });
  checks.push({
    name: "token count is EXACT (not estimated)",
    ok: turn0?.token_counts.token_count_method === "exact" && turn0.token_counts.input_tokens > 0,
    detail: `method=${turn0?.token_counts.token_count_method} input_tokens=${turn0?.token_counts.input_tokens}`,
  });
  checks.push({ name: "0 turns dropped (redaction)", ok: session?.dropped_turns === 0, detail: `dropped=${session?.dropped_turns}` });

  out("");
  for (const c of checks) out(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  const passed = checks.every((c) => c.ok);
  out("");
  out(passed ? "RESULT: PASS — live proxy path verified end-to-end." : "RESULT: FAIL — see checks above.");
  out(`(capture artifact: ${outFile})`);
  return passed ? 0 : 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("smoke-live.ts") || entryPath.endsWith("smoke-live.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
