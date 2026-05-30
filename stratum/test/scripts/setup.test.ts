// Unit tests for the setup/readiness pure seams. The I/O (file checks, model
// pre-fetch, printing) is exercised by running `npm run setup`.

import { describe, test, expect } from "vitest";
import { nodeMajor, isPlaceholder, assessCapabilities, readinessTiers, type Capabilities } from "../../scripts/setup";

describe("nodeMajor", () => {
  test("parses with/without the v prefix", () => {
    expect(nodeMajor("24.12.0")).toBe(24);
    expect(nodeMajor("v20.0.0")).toBe(20);
    expect(nodeMajor("18.19.1")).toBe(18);
  });
  test("unparseable → 0 (so it reads as below-min, never a false pass)", () => {
    expect(nodeMajor("")).toBe(0);
    expect(nodeMajor("garbage")).toBe(0);
  });
});

describe("isPlaceholder", () => {
  test("unfilled .env.example values are placeholders (not configured)", () => {
    expect(isPlaceholder(undefined)).toBe(true);
    expect(isPlaceholder("")).toBe(true);
    expect(isPlaceholder("   ")).toBe(true);
    expect(isPlaceholder("...")).toBe(true);
    expect(isPlaceholder("sk-ant-...")).toBe(true); // ends with ...
    expect(isPlaceholder("eyJ...")).toBe(true);
    expect(isPlaceholder("https://xxx.supabase.co")).toBe(true); // contains xxx
    expect(isPlaceholder("neo4j+s://xxx.databases.neo4j.io")).toBe(true);
  });
  test("real values are NOT placeholders", () => {
    expect(isPlaceholder("sk-ant-api03-RealLookingKey_abc123")).toBe(false);
    expect(isPlaceholder("https://kdeqkijtagypiwnrwmem.supabase.co")).toBe(false);
    expect(isPlaceholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.real.jwt")).toBe(false);
  });
});

describe("assessCapabilities", () => {
  const withKeys = (keys: string[]): Capabilities => {
    const set = new Set(keys);
    return assessCapabilities((k) => set.has(k));
  };

  test("local is always available", () => {
    expect(withKeys([]).local).toBe(true);
  });
  test("supabase needs BOTH url and service key", () => {
    expect(withKeys(["SUPABASE_URL"]).supabase).toBe(false);
    expect(withKeys(["SUPABASE_URL", "SUPABASE_SERVICE_KEY"]).supabase).toBe(true);
  });
  test("anthropic on its own key; audit-model needs endpoint + key; tee needs cid + pcr0", () => {
    expect(withKeys(["ANTHROPIC_API_KEY"]).anthropic).toBe(true);
    expect(withKeys(["AUDIT_MODEL_ENDPOINT"]).auditModel).toBe(false);
    expect(withKeys(["AUDIT_MODEL_ENDPOINT", "AUDIT_MODEL_API_KEY"]).auditModel).toBe(true);
    expect(withKeys(["AWS_NITRO_ENCLAVE_CID"]).tee).toBe(false);
    expect(withKeys(["AWS_NITRO_ENCLAVE_CID", "AWS_NITRO_PCR0"]).tee).toBe(true);
  });
});

describe("readinessTiers", () => {
  test("reflects which tiers are live and always lists the FREE tier first", () => {
    const caps = assessCapabilities((k) => k === "SUPABASE_URL" || k === "SUPABASE_SERVICE_KEY");
    const tiers = readinessTiers(caps);
    expect(tiers[0]!.title).toMatch(/FREE \/ local/);
    expect(tiers[0]!.live).toBe(true);
    expect(tiers.find((t) => t.title.includes("Supabase"))!.live).toBe(true);
    expect(tiers.find((t) => t.title.includes("Anthropic"))!.live).toBe(false);
    expect(tiers.find((t) => t.title.includes("Anthropic"))!.note).toMatch(/set ANTHROPIC_API_KEY/);
  });
});
