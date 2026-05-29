// Unit tests for Tier-2 Llama spot-check (pure logic + injected fake completion —
// no API, no fabricated verdict).

import { describe, test, expect } from "vitest";
import { buildSpotCheckPrompt, parseCoherence, shouldSpotCheck, spotCheckFact, SPOT_CHECK_RATE, type AuditCompletion } from "../../src/audit/llama-check";
import type { AnyFact } from "../../src/types/facts";

const fact: AnyFact = { id: "f-1", created_at: "2026-01-01T00:00:00Z", session_id: "s", confidence: 0.9, is_verified: false, is_suppressed: false, fact_type: "TechDecision", decision_text: "use Dragonfly for session cache", domain: "infrastructure" };

describe("shouldSpotCheck (deterministic ~10% sample)", () => {
  test("is deterministic per id", () => {
    expect(shouldSpotCheck("abc")).toBe(shouldSpotCheck("abc"));
  });
  test("rate 1.0 → always; rate 0 → never", () => {
    expect(shouldSpotCheck("x", 1)).toBe(true);
    expect(shouldSpotCheck("x", 0)).toBe(false);
  });
  test("samples roughly the configured fraction over many ids", () => {
    let n = 0;
    const total = 2000;
    for (let i = 0; i < total; i++) if (shouldSpotCheck(`id-${i}`, SPOT_CHECK_RATE)) n++;
    const frac = n / total;
    expect(frac).toBeGreaterThan(0.05); // not ~0
    expect(frac).toBeLessThan(0.16); // not ~all; near 10% (wide band for hash non-uniformity)
  });
});

describe("buildSpotCheckPrompt", () => {
  test("includes the fact + the untrusted-data guard + the JSON instruction", () => {
    const p = buildSpotCheckPrompt(fact, ["user: switch cache", "assistant: ok, Dragonfly"]);
    expect(p).toContain("Dragonfly");
    expect(p).toMatch(/UNTRUSTED DATA/);
    expect(p).toContain('"coherent"');
    expect(p).toContain("<<CONVERSATION>>");
  });
});

describe("parseCoherence", () => {
  test("parses + clamps; tolerates surrounding prose", () => {
    expect(parseCoherence('noise {"coherent": true, "confidence": 1.4, "reason": "ok"} tail')).toEqual({ coherent: true, confidence: 1, reason: "ok" });
    expect(parseCoherence('{"coherent": false, "confidence": -0.2, "reason": "x"}')).toEqual({ coherent: false, confidence: 0, reason: "x" });
  });
  test("fail-loud: throws (never invents) on bad output", () => {
    expect(() => parseCoherence("looks fine to me")).toThrow(/no JSON/);
    expect(() => parseCoherence('{"coherent":"yes","confidence":0.9}')).toThrow(/boolean coherent/);
    expect(() => parseCoherence('{"coherent":true}')).toThrow(/numeric confidence/);
  });
  test("reason defaults to empty string when absent", () => {
    expect(parseCoherence('{"coherent":true,"confidence":0.9}').reason).toBe("");
  });
});

describe("spotCheckFact (injected fake completion)", () => {
  const fakeReturning = (reply: string): AuditCompletion => ({ complete: () => Promise.resolve(reply) });

  test("confidence ≥ 0.85 → keep UNVERIFIED (no escalation)", async () => {
    const o = await spotCheckFact(fact, ["turn"], fakeReturning('{"coherent":true,"confidence":0.92,"reason":"consistent"}'));
    expect(o.verdict.confidence).toBe(0.92);
    expect(o.escalate).toBe(false);
  });
  test("confidence < 0.85 → escalate to Tier-3", async () => {
    const o = await spotCheckFact(fact, ["turn"], fakeReturning('{"coherent":false,"confidence":0.4,"reason":"contradicts the turn"}'));
    expect(o.escalate).toBe(true);
  });
});
