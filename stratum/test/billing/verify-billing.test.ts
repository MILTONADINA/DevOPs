// Unit tests for verify-billing's pure seams (parseArgs, rowToInput). The verify
// LOGIC is covered in recorder.test.ts; the live read is exercised by `npm run verify-billing`.

import { describe, test, expect } from "vitest";
import { parseArgs, rowToInput } from "../../scripts/verify-billing";

describe("parseArgs", () => {
  test("defaults + flags", () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--org-id", "o1", "--since", "a", "--until", "b"])).toEqual({ orgId: "o1", since: "a", until: "b" });
  });
});

describe("rowToInput", () => {
  test("maps a stored row to its signing inputs; drops a null pruning_log_id", () => {
    const input = rowToInput({ id: "r1", session_id: "s1", org_id: "o1", original_tokens: 100, quarantined_tokens: 40, api_price_per_token: 0.000015, pruning_log_id: null, signed_hash: "h" });
    expect(input).toEqual({ sessionId: "s1", orgId: "o1", originalTokens: 100, quarantinedTokens: 40, apiPricePerToken: 0.000015 });
    expect(input).not.toHaveProperty("pruningLogId");
  });
  test("keeps a present pruning_log_id", () => {
    expect(rowToInput({ id: "r1", session_id: "s1", org_id: "o1", original_tokens: 1, quarantined_tokens: 0, api_price_per_token: 1, pruning_log_id: "pl1", signed_hash: "h" }).pruningLogId).toBe("pl1");
  });
});
