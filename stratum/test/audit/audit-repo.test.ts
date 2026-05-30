// Unit tests for the audit-repo runner's pure seams (parseArgs, summarizeIndex).
// The end-to-end path (indexRepository → auditFacts) shells real `git` and is
// exercised by the live `npm run audit:repo`; here we lock the pure logic only.

import { describe, test, expect } from "vitest";
import { parseArgs, summarizeIndex } from "../../scripts/audit-repo";
import type { CodeChange } from "../../src/audit/git-attestation";

describe("parseArgs", () => {
  test("defaults: no facts, maxCount 100, no persist", () => {
    const a = parseArgs([]);
    expect(a.factsPath).toBeUndefined();
    expect(a.maxCount).toBe(100);
    expect(a.persist).toBe(false);
    expect(a.orgId).toBeUndefined();
    expect(a.sessionId).toBeUndefined();
  });

  test("parses all flags", () => {
    const a = parseArgs(["--facts", "c.json", "--max-count", "50", "--persist", "--org-id", "o1", "--session-id", "s1"]);
    expect(a.factsPath).toBe("c.json");
    expect(a.maxCount).toBe(50);
    expect(a.persist).toBe(true);
    expect(a.orgId).toBe("o1");
    expect(a.sessionId).toBe("s1");
  });

  test("a non-numeric / non-positive --max-count falls back to 100 (never 0 / NaN)", () => {
    expect(parseArgs(["--max-count", "abc"]).maxCount).toBe(100);
    expect(parseArgs(["--max-count", "0"]).maxCount).toBe(100); // max(1, 0||100)=100
    expect(parseArgs(["--max-count", "-5"]).maxCount).toBe(1); // max(1, -5)=1
  });

  test("a flag with a missing trailing value does not crash (empty string)", () => {
    const a = parseArgs(["--facts"]);
    expect(a.factsPath).toBe("");
  });
});

describe("summarizeIndex", () => {
  const mk = (over: Partial<CodeChange>): CodeChange => ({ entity: "f", changeType: "modified", commitHash: "abc123", message: "m", timestampSeconds: 1, ...over });

  test("counts distinct commits, files, and each change type", () => {
    const changes: CodeChange[] = [
      mk({ commitHash: "c1", filePath: "a.ts", changeType: "added" }),
      mk({ commitHash: "c1", filePath: "a.ts", changeType: "modified" }), // same commit + file
      mk({ commitHash: "c2", filePath: "b.ts", changeType: "deleted" }),
      mk({ commitHash: "c2", filePath: "b.ts", changeType: "renamed", toEntity: "g" }), // renamed not tallied in a/d/m
    ];
    const s = summarizeIndex(changes);
    expect(s.commits).toBe(2);
    expect(s.files).toBe(2);
    expect(s.added).toBe(1);
    expect(s.deleted).toBe(1);
    expect(s.modified).toBe(1);
  });

  test("empty change-set → all zero", () => {
    expect(summarizeIndex([])).toEqual({ commits: 0, added: 0, deleted: 0, modified: 0, files: 0 });
  });

  test("a change with no filePath is not counted as a file", () => {
    const s = summarizeIndex([mk({ commitHash: "c1" })]); // no filePath
    expect(s.files).toBe(0);
    expect(s.commits).toBe(1);
  });
});
