// Contract test for the Phase-4 client-encryption interface stub: it must
// REJECT (never return placeholder crypto), so accidental use fails loudly.

import { describe, test, expect } from "vitest";
import { deriveSessionKey, encryptSpans } from "../../src/pruner/crypto";

describe("crypto.ts — Phase 4 interface stub", () => {
  test("deriveSessionKey rejects (not implemented)", async () => {
    await expect(deriveSessionKey(new Uint8Array(32), "sess")).rejects.toThrow(/Phase 4|not implemented/i);
  });
  test("encryptSpans rejects (not implemented)", async () => {
    await expect(encryptSpans("ctx", new Uint8Array(32), "nonce")).rejects.toThrow(/Phase 4|not implemented/i);
  });
});
