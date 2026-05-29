// Unit tests for the git indexer. The PARSERS are pure (fixture `git log -p`
// output → CodeChange[]); indexRepository is tested with an INJECTED fake runner
// (no real git). A guarded test exercises the real `git` against this repo.

import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  extractChangesFromPatch,
  parseGitLog,
  parseGitLogWithPatches,
  indexRepository,
  GIT_LOG_FORMAT,
  type GitRunner,
} from "../../src/audit/git-indexer";

const REC = "\x1e";
const UNIT = "\x1f";
const rec = (hash: string, ct: number, subject: string, patch: string): string => `${REC}${hash}${UNIT}${ct}${UNIT}${subject}${UNIT}\n${patch}`;

const RENAME_PATCH = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,3 @@
-export function getUser(id) {
+export function fetchUser(id) {
   return db.find(id);
 }
`;

describe("extractChangesFromPatch", () => {
  test("a rename diff yields deleted-old + added-new (with file path)", () => {
    const changes = extractChangesFromPatch(RENAME_PATCH, { hash: "a3f9b2", timestampSeconds: 1000, message: "rename getUser" });
    const byEntity = Object.fromEntries(changes.map((c) => [c.entity, c]));
    expect(byEntity["getUser"]?.changeType).toBe("deleted");
    expect(byEntity["fetchUser"]?.changeType).toBe("added");
    expect(byEntity["fetchUser"]?.filePath).toBe("src/auth.ts");
    expect(byEntity["fetchUser"]?.commitHash).toBe("a3f9b2");
  });

  test("a binding changed on both sides → modified", () => {
    const patch = `+++ b/config.ts\n-const API_URL = "http://old";\n+const API_URL = "https://new";\n`;
    const changes = extractChangesFromPatch(patch, { hash: "c1", timestampSeconds: 1, message: "m" });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ entity: "API_URL", changeType: "modified" });
  });

  test("detects python def + go func + class additions", () => {
    const patch = `+++ b/x\n+def process_data(x):\n+class Widget:\n+func Handle(w http.ResponseWriter) {\n`;
    const ents = extractChangesFromPatch(patch, { hash: "c2", timestampSeconds: 1, message: "m" }).map((c) => c.entity).sort();
    expect(ents).toEqual(["Handle", "Widget", "process_data"]);
  });

  test("ignores +++/--- file headers and non-declaration lines", () => {
    const patch = `--- a/x\n+++ b/x\n+  return db.find(id);\n+// a comment\n`;
    expect(extractChangesFromPatch(patch, { hash: "c3", timestampSeconds: 1, message: "m" })).toEqual([]);
  });
});

describe("parseGitLog / parseGitLogWithPatches", () => {
  test("parseGitLog reads commit metadata", () => {
    const raw = rec("h1", 1700, "first", "") + rec("h2", 1800, "second", "");
    expect(parseGitLog(raw)).toEqual([
      { hash: "h1", timestampSeconds: 1700, message: "first" },
      { hash: "h2", timestampSeconds: 1800, message: "second" },
    ]);
  });

  test("parseGitLogWithPatches yields code changes across commits", () => {
    const raw = rec("a3f9b2", 1000, "rename getUser", RENAME_PATCH);
    const changes = parseGitLogWithPatches(raw);
    expect(changes.map((c) => `${c.entity}:${c.changeType}`).sort()).toEqual(["fetchUser:added", "getUser:deleted"]);
    expect(changes.every((c) => c.commitHash === "a3f9b2" && c.timestampSeconds === 1000)).toBe(true);
  });

  test("empty / blank input → no changes", () => {
    expect(parseGitLogWithPatches("")).toEqual([]);
    expect(parseGitLog("")).toEqual([]);
  });
});

describe("indexRepository (injected fake git runner — no real git)", () => {
  test("composes runGit → parse → CodeChange[]; passes the right git args", async () => {
    let seenArgs: string[] = [];
    const fakeRun: GitRunner = (args) => {
      seenArgs = args;
      return Promise.resolve(rec("a3f9b2", 1000, "rename", RENAME_PATCH));
    };
    const changes = await indexRepository({ maxCount: 5, sinceIso: "2026-01-01" }, fakeRun);
    expect(changes.map((c) => c.entity).sort()).toEqual(["fetchUser", "getUser"]);
    expect(seenArgs).toContain("log");
    expect(seenArgs).toContain("-p");
    expect(seenArgs).toContain(`--format=${GIT_LOG_FORMAT}`);
    expect(seenArgs).toContain("--max-count=5");
    expect(seenArgs.some((a) => a.startsWith("--since="))).toBe(true);
  });
});

// Guarded: run the REAL `git` against this repo (free). Skips if `git` is absent.
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
describe.skipIf(!gitAvailable())("indexRepository against the real repo (live, free)", () => {
  test("returns without error over the last few commits", async () => {
    const changes = await indexRepository({ maxCount: 5 });
    expect(Array.isArray(changes)).toBe(true); // parses real `git log -p` output without throwing
    for (const c of changes) {
      expect(typeof c.entity).toBe("string");
      expect(["added", "deleted", "modified", "renamed"]).toContain(c.changeType);
    }
  });
});
