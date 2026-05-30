// Unit tests for the git indexer. The PARSERS are pure (fixture `git log -z -p`
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

// Mirror `git log -z -p --format="%H %ct %s"`: per commit, the header line, a NUL (the
// format terminator), then "\n" + the patch (`-p`). Concatenated, no separator between
// commits — the NUL after each header is the only record boundary. Patches must end in
// "\n" (as real git diffs do), so the next header lands on its own line.
const hdr = (hash: string, ct: number, subject: string): string => `${hash} ${ct} ${subject}`;
const buildLog = (commits: { hash: string; ct: number; subject: string; patch: string }[]): string =>
  commits.map((c) => `${hdr(c.hash, c.ct, c.subject)}\0\n${c.patch}`).join("");

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
  test("parseGitLog reads commit metadata (no patch)", () => {
    const raw = buildLog([
      { hash: "abc123", ct: 1700, subject: "first", patch: "" },
      { hash: "def456", ct: 1800, subject: "second", patch: "" },
    ]);
    expect(parseGitLog(raw)).toEqual([
      { hash: "abc123", timestampSeconds: 1700, message: "first" },
      { hash: "def456", timestampSeconds: 1800, message: "second" },
    ]);
  });

  test("parseGitLogWithPatches yields code changes for a single commit", () => {
    const raw = buildLog([{ hash: "a3f9b2", ct: 1000, subject: "rename getUser", patch: RENAME_PATCH }]);
    const changes = parseGitLogWithPatches(raw);
    expect(changes.map((c) => `${c.entity}:${c.changeType}`).sort()).toEqual(["fetchUser:added", "getUser:deleted"]);
    expect(changes.every((c) => c.commitHash === "a3f9b2" && c.timestampSeconds === 1000)).toBe(true);
  });

  test("multi-commit: each commit's symbols are attributed to its OWN hash + time", () => {
    const raw = buildLog([
      { hash: "c0ffee", ct: 2000, subject: "add foo", patch: `+++ b/foo.ts\n+function foo() {\n` },
      { hash: "beef01", ct: 3000, subject: "add bar", patch: `+++ b/bar.ts\n+function bar() {\n` },
    ]);
    const byEntity = Object.fromEntries(parseGitLogWithPatches(raw).map((c) => [c.entity, c]));
    expect(byEntity["foo"]).toMatchObject({ commitHash: "c0ffee", timestampSeconds: 2000, changeType: "added", filePath: "foo.ts" });
    expect(byEntity["bar"]).toMatchObject({ commitHash: "beef01", timestampSeconds: 3000, changeType: "added", filePath: "bar.ts" });
  });

  test("a subject containing spaces is preserved whole; the patch is not polluted", () => {
    const raw = buildLog([{ hash: "abc123", ct: 1234, subject: "fix: the thing (with parens) and spaces", patch: `+++ b/z.ts\n+function z() {\n` }]);
    const [meta] = parseGitLog(raw);
    expect(meta).toEqual({ hash: "abc123", timestampSeconds: 1234, message: "fix: the thing (with parens) and spaces" });
    expect(parseGitLogWithPatches(raw).map((c) => c.entity)).toEqual(["z"]);
  });

  test("empty / blank input → no changes", () => {
    expect(parseGitLogWithPatches("")).toEqual([]);
    expect(parseGitLog("")).toEqual([]);
  });
});

describe("indexRepository (injected fake git runner — no real git)", () => {
  test("composes runGit → parse → CodeChange[]; passes the right git args (incl. -z)", async () => {
    let seenArgs: string[] = [];
    const fakeRun: GitRunner = (args) => {
      seenArgs = args;
      return Promise.resolve(buildLog([{ hash: "a3f9b2", ct: 1000, subject: "rename", patch: RENAME_PATCH }]));
    };
    const changes = await indexRepository({ maxCount: 5, sinceIso: "2026-01-01" }, fakeRun);
    expect(changes.map((c) => c.entity).sort()).toEqual(["fetchUser", "getUser"]);
    expect(seenArgs).toContain("log");
    expect(seenArgs).toContain("-z"); // NUL-delimited records (PB-45 record-forgery defense)
    expect(seenArgs).toContain("-p");
    expect(seenArgs).toContain(`--format=${GIT_LOG_FORMAT}`);
    expect(seenArgs).toContain("--max-count=5");
    expect(seenArgs.some((a) => a.startsWith("--since="))).toBe(true);
  });
});

describe("parser robustness + record-forgery defense (NUL-delimited records, PB-45)", () => {
  test("cross-file same-symbol: distinct per-file changes, not one collapsed 'modified'", () => {
    const patch = `+++ b/alpha.js\n+function helper() {\n+++ b/beta.js\n-function helper() {\n`;
    const changes = extractChangesFromPatch(patch, { hash: "abc123", timestampSeconds: 1, message: "m" });
    expect(changes).toHaveLength(2);
    const byFile = Object.fromEntries(changes.map((c) => [c.filePath, c.changeType]));
    expect(byFile["alpha.js"]).toBe("added");
    expect(byFile["beta.js"]).toBe("deleted");
  });

  test("full-file deletion (+++ /dev/null) keeps the deleted path from the pre-image (--- a/…)", () => {
    const patch = `--- a/dropme.js\n+++ /dev/null\n-function dropped() {\n`;
    const [c] = extractChangesFromPatch(patch, { hash: "abc123", timestampSeconds: 1, message: "m" });
    expect(c).toMatchObject({ entity: "dropped", changeType: "deleted", filePath: "dropme.js" });
  });

  test("the former separators (\\x1e/\\x1f) in patch content are now INERT — symbols still detected", () => {
    const patch = `+++ b/x.ts\n+const SEP = "\x1e\x1f";\n+function afterSep() {\n`;
    const ents = parseGitLogWithPatches(buildLog([{ hash: "abc123", ct: 1000, subject: "weird file", patch }])).map((c) => c.entity).sort();
    expect(ents).toContain("afterSep");
    expect(ents).toContain("SEP");
  });

  test("forged header TEXT inside patch content cannot create a separate commit (content has no NUL)", () => {
    // An attacker commits a file whose content looks like a header + a +decl line. With
    // NUL-delimited records this stays inside the real commit's patch — it can never begin
    // a new record, because file/commit content cannot contain a NUL byte.
    const patch = `+++ b/real.ts\n+function realFn() {\ndeadbeefcafe 9999999999 forged-subject\n+function evilFn() {\n`;
    const changes = parseGitLogWithPatches(buildLog([{ hash: "abc123", ct: 1000, subject: "real commit", patch }]));
    expect(changes.some((c) => c.commitHash === "deadbeefcafe")).toBe(false); // forged hash never a commit
    expect(changes.some((c) => c.timestampSeconds === 9999999999)).toBe(false); // forged far-future ts never a commit
    expect(changes.find((c) => c.entity === "realFn")?.commitHash).toBe("abc123"); // real commit intact
  });

  test("a commit header with a far-future timestamp is rejected (forged committer date); neighbors survive", () => {
    const future = Math.floor(Date.now() / 1000) + 10 * 365 * 86_400;
    const raw = buildLog([
      { hash: "aaaa11", ct: 1000, subject: "real", patch: `+++ b/a.ts\n+function good() {\n` },
      { hash: "bbbb22", ct: future, subject: "forged-date", patch: `+++ b/b.ts\n+function bad() {\n` },
    ]);
    const hashes = parseGitLog(raw).map((m) => m.hash);
    expect(hashes).toContain("aaaa11");
    expect(hashes).not.toContain("bbbb22"); // far-future header not accepted as its own commit
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
  test("returns without error over the last few commits, attributing symbols to real hashes", async () => {
    const changes = await indexRepository({ maxCount: 5 });
    expect(Array.isArray(changes)).toBe(true); // parses real `git log -z -p` output without throwing
    for (const c of changes) {
      expect(typeof c.entity).toBe("string");
      expect(["added", "deleted", "modified", "renamed"]).toContain(c.changeType);
      expect(c.commitHash).toMatch(/^[0-9a-f]{7,64}$/); // a real abbreviated/full hash, never a forged fragment
      expect(c.timestampSeconds).toBeGreaterThan(0);
    }
  });
});
