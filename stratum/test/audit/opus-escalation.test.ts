// Unit tests for Tier-3 Opus escalation (pure logic + injected fake completion).

import { describe, test, expect } from "vitest";
import { buildEscalationPrompt, parseOpusVerdict, escalateFact } from "../../src/audit/opus-escalation";
import type { AuditCompletion } from "../../src/audit/llama-check";
import type { AnyFact } from "../../src/types/facts";

const fact: AnyFact = { id: "f-1", created_at: "2026-01-01T00:00:00Z", session_id: "s", confidence: 0.9, is_verified: false, is_suppressed: false, fact_type: "FunctionChange", old_name: "getUser", new_name: "fetchUser", change_type: "renamed" };

describe("buildEscalationPrompt", () => {
  test("includes fact + session + git fences and the verdict instruction", () => {
    const p = buildEscalationPrompt(fact, "user: rename getUser", "getUser deleted in c7d1e4");
    expect(p).toContain("getUser");
    expect(p).toContain("<<SESSION>>");
    expect(p).toContain("<<GIT>>");
    expect(p).toMatch(/UNTRUSTED DATA/);
    expect(p).toContain("SUPPRESSED");
  });
});

describe("parseOpusVerdict", () => {
  test("parses each valid verdict + clamps confidence", () => {
    expect(parseOpusVerdict('{"verdict":"CONFIRMED","confidence":0.99,"reasoning":"matches git"}')).toEqual({ verdict: "CONFIRMED", confidence: 0.99, reasoning: "matches git" });
    expect(parseOpusVerdict('pre {"verdict":"SUPPRESSED","confidence":1.5,"reasoning":"false"} post')).toEqual({ verdict: "SUPPRESSED", confidence: 1, reasoning: "false" });
  });
  test("fail-loud: throws (never invents) on bad output", () => {
    expect(() => parseOpusVerdict("no json")).toThrow(/no JSON/);
    expect(() => parseOpusVerdict('{"verdict":"MAYBE","confidence":0.9}')).toThrow(/valid verdict/);
    expect(() => parseOpusVerdict('{"verdict":"CONFIRMED"}')).toThrow(/numeric confidence/);
  });
});

describe("escalateFact (injected fake completion)", () => {
  const fake = (reply: string): AuditCompletion => ({ complete: () => Promise.resolve(reply) });
  test("returns the model's final verdict", async () => {
    const v = await escalateFact(fact, "session", "git", fake('{"verdict":"SUPPRESSED","confidence":0.93,"reasoning":"deleted later"}'));
    expect(v.verdict).toBe("SUPPRESSED");
    expect(v.confidence).toBe(0.93);
  });
});
