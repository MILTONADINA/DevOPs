import { describe, expect, test } from "vitest";
import { parseArgs } from "../../scripts/create-api-key";

describe("create-api-key project binding", () => {
  test("a valid project slug is retained for key creation", () => {
    expect(parseArgs(["--org-id", "org", "--name", "agent", "--project-scope", "orion-api"])).toMatchObject({ orgId: "org", name: "agent", projectScope: "orion-api" });
    expect(parseArgs(["--org-id", "org", "--name", "agent"]).projectScope).toBeUndefined();
  });

  test.each(["", "../other", "UPPER", "-bad", "bad-", "a_b", "a".repeat(65)])("rejects malformed project slug %j before database access", (scope) => {
    expect(() => parseArgs(["--project-scope", scope])).toThrow(/invalid --project-scope/);
  });
});
