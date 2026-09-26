// NOTE: test/setup.ts (global vitest setupFile) mocks node:fs's `writeFileSync`
// and `mkdirSync` as no-ops for every test file in this project (to keep the
// capture-session.ts hermetic tests off the real disk). This file writes its
// temp fixtures with `fs.promises.writeFile` instead, which that mock leaves
// untouched (only the two named exports above are overridden — everything
// else, including `promises`, `readFileSync`, `createReadStream`,
// `mkdtempSync`, and `rmSync`, still comes from the real module). See
// test/setup.ts's `vi.mock('node:fs', ...)` factory.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, promises as fsp, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProvenanceFixture,
  verifyCommittedSha256,
  PROVENANCE_WINDOW_MS,
  ProvenanceFixtureRejectedError,
  ShaMismatchError,
  translateProvenanceCase,
  lexicalQueryTokens,
  lexicalTurnTokens,
  lexicalSimilarity,
  runProvenanceDevCase,
  buildProvenanceDevReport,
  formatProvenanceCaseFailure,
  type ProvenanceCase,
  type ProvenanceDevCaseResult,
  type ProvenanceSelector,
} from "../../evals/harness/provenance-fixture";
import { selectWithProvenance } from "../../src/pruner/provenance-select";

/** A turn beyond PROVENANCE_WINDOW_MS, tied to the real constant rather than a magic number. */
const OVER_WINDOW_AGE_SECONDS = PROVENANCE_WINDOW_MS / 1000 + 1;

function makeValidCase(overrides: Partial<ProvenanceCase> = {}): ProvenanceCase {
  const base: ProvenanceCase = {
    id: "pg-test-1",
    tags: ["production_reachable"],
    query: "how do we retry a failed widget publish",
    exchanges: [
      {
        exchangeId: "11111111-1111-4111-8111-111111111111",
        write: "ok",
        turns: [
          { role: "user", text: "why did the widget publish fail", ageSeconds: 200 },
          { role: "assistant", text: "the widget publish failed on a timeout", ageSeconds: 190 },
        ],
        facts: [{ factId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", table: "tech_decisions", createdAtSeconds: 1_000, matchesQuery: true }],
      },
    ],
    unboundTurns: [],
    reviewedLinks: [],
    foreign: [],
    expect: {
      fallback: null,
      sameAsBase: false,
      requiredExchangeIds: [],
      forbiddenExchangeIds: [],
      notAddedExchangeIds: [],
      notRemovedExchangeIds: [],
      pinnedLimitation: [],
      derivation: {},
    },
  };
  return { ...base, ...overrides };
}

/** Write one case per line, plus a matching `.sha256` sidecar (real digest of the bytes just written). */
async function writeFixture(dir: string, filename: string, cases: unknown[]): Promise<{ filePath: string; sha256: string }> {
  const filePath = join(dir, filename);
  const content = `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`;
  await fsp.writeFile(filePath, content, "utf8");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  await fsp.writeFile(`${filePath}.sha256`, `${sha256}  ${filename}\n`, "utf8");
  return { filePath, sha256 };
}

/**
 * Write a synthetic reference corpus, distinct from the real committed
 * golden/Tier-B datasets — every test in this file except the "T1B" describe
 * block below uses only this synthetic kind, never the real corpora.
 */
async function writeReferenceCorpus(dir: string, filename: string, lines: unknown[]): Promise<string> {
  const filePath = join(dir, filename);
  await fsp.writeFile(filePath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
  return filePath;
}

async function expectRejected(filePath: string, referenceCorpusPaths: string[] = []) {
  let caught: unknown;
  try {
    await loadProvenanceFixture(filePath, referenceCorpusPaths);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProvenanceFixtureRejectedError);
  return (caught as ProvenanceFixtureRejectedError).violations;
}

describe("provenance fixture loader", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provenance-fixture-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts a case that violates none of the five reject rules", async () => {
    const { filePath } = await writeFixture(dir, "happy.jsonl", [makeValidCase()]);
    const result = await loadProvenanceFixture(filePath, []);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pg-test-1");
  });

  test("rejects when the file's bytes do not match its committed .sha256 sidecar", async () => {
    const { filePath, sha256 } = await writeFixture(dir, "mismatch.jsonl", [makeValidCase()]);
    const wrongHash = sha256.startsWith("0") ? `1${sha256.slice(1)}` : `0${sha256.slice(1)}`;
    await fsp.writeFile(`${filePath}.sha256`, `${wrongHash}  mismatch.jsonl\n`, "utf8");

    let caught: unknown;
    try {
      await loadProvenanceFixture(filePath, []);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShaMismatchError);
    const e = caught as ShaMismatchError;
    expect(e.filePath).toBe(filePath);
    expect(e.expected).toBe(wrongHash);
    expect(e.actual).toBe(sha256);
  });

  describe("rule 1 — 5-gram overlap with a reference corpus", () => {
    const CORPUS_LINE = { note: "alpha bravo charlie delta echo foxtrot golf" };

    test("rejects a case sharing a full 5-gram with the reference corpus", async () => {
      const corpusPath = await writeReferenceCorpus(dir, "ref.jsonl", [CORPUS_LINE]);
      const caseObj = makeValidCase({
        id: "pg-rule1-reject",
        exchanges: [
          {
            exchangeId: "55555555-5555-4555-8555-555555555555",
            turns: [
              { role: "user", text: "our incident notes said bravo charlie delta echo foxtrot yesterday afternoon", ageSeconds: 100 },
              { role: "assistant", text: "reply", ageSeconds: 90 },
            ],
            facts: [],
          },
        ],
      });
      const { filePath } = await writeFixture(dir, "rule1-reject.jsonl", [caseObj]);
      const violations = await expectRejected(filePath, [corpusPath]);
      expect(violations).toContainEqual(expect.objectContaining({ id: "pg-rule1-reject", rule: "five_gram_overlap", detail: `shares a 5-gram with ${corpusPath}` }));
    });

    test("does not reject a case sharing only a 4-gram with the reference corpus", async () => {
      const corpusPath = await writeReferenceCorpus(dir, "ref.jsonl", [CORPUS_LINE]);
      const caseObj = makeValidCase({
        id: "pg-rule1-control",
        exchanges: [
          {
            exchangeId: "66666666-6666-4666-8666-666666666666",
            turns: [
              { role: "user", text: "our incident notes said xzq charlie delta echo foxtrot zzq yesterday", ageSeconds: 100 },
              { role: "assistant", text: "reply", ageSeconds: 90 },
            ],
            facts: [],
          },
        ],
      });
      const { filePath } = await writeFixture(dir, "rule1-control.jsonl", [caseObj]);
      const result = await loadProvenanceFixture(filePath, [corpusPath]);
      expect(result).toHaveLength(1);
    });
  });

  test("rule 2 — rejects a case naming an exchange id with no matching expect.derivation entry", async () => {
    const caseObj = makeValidCase({
      id: "pg-rule2-reject",
      expect: {
        fallback: null,
        sameAsBase: false,
        requiredExchangeIds: ["exch-missing-derivation"],
        forbiddenExchangeIds: [],
        notAddedExchangeIds: [],
        notRemovedExchangeIds: [],
        pinnedLimitation: [],
        derivation: {},
      },
    });
    const { filePath } = await writeFixture(dir, "rule2.jsonl", [caseObj]);
    const violations = await expectRejected(filePath);
    expect(violations).toContainEqual(expect.objectContaining({ id: "pg-rule2-reject", rule: "derivation_free_expectation" }));
  });

  describe("rule 3 — reviewedLinks entry naming an older successor", () => {
    function makeInvertedLinkCase(id: string, tags: string[]): ProvenanceCase {
      return makeValidCase({
        id,
        tags,
        exchanges: [
          {
            exchangeId: "22222222-2222-4222-8222-222222222222",
            turns: [
              { role: "user", text: "question about policy history", ageSeconds: 300 },
              { role: "assistant", text: "policy history answer", ageSeconds: 290 },
            ],
            facts: [
              { factId: "fact-old", table: "tech_decisions", createdAtSeconds: 5_000 },
              { factId: "fact-new", table: "tech_decisions", createdAtSeconds: 1_000 },
            ],
          },
        ],
        reviewedLinks: [{ newerFactId: "fact-new", olderFactId: "fact-old", reviewer: "alice reviewer", evidence: "checked the audit log for this decision" }],
      });
    }

    test("rejects when the case is not tagged db_rejects", async () => {
      const { filePath } = await writeFixture(dir, "rule3-reject.jsonl", [makeInvertedLinkCase("pg-rule3-reject", ["production_reachable"])]);
      const violations = await expectRejected(filePath);
      expect(violations).toContainEqual(expect.objectContaining({ id: "pg-rule3-reject", rule: "reviewed_link_older_successor" }));
    });

    test("does not reject when the case is tagged db_rejects", async () => {
      const { filePath } = await writeFixture(dir, "rule3-control.jsonl", [makeInvertedLinkCase("pg-rule3-control", ["production_reachable", "db_rejects"])]);
      const result = await loadProvenanceFixture(filePath, []);
      expect(result).toHaveLength(1);
    });
  });

  test("rule 4 — rejects a case with a fact table outside the six known tables", async () => {
    const caseObj = makeValidCase({
      id: "pg-rule4-reject",
      exchanges: [
        {
          exchangeId: "33333333-3333-4333-8333-333333333333",
          turns: [
            { role: "user", text: "question", ageSeconds: 100 },
            { role: "assistant", text: "answer", ageSeconds: 90 },
          ],
          facts: [{ factId: "fact-bad-table", table: "not_a_real_table", createdAtSeconds: 1_000 }],
        },
      ],
    });
    const { filePath } = await writeFixture(dir, "rule4.jsonl", [caseObj]);
    const violations = await expectRejected(filePath);
    expect(violations).toContainEqual(expect.objectContaining({ id: "pg-rule4-reject", rule: "invalid_fact_table" }));
  });

  describe("rule 5 — a turn beyond windowMs on a case not tagged long_window_not_production_reachable", () => {
    function makeOldTurnCase(id: string, tags: string[]): ProvenanceCase {
      return makeValidCase({
        id,
        tags,
        exchanges: [
          {
            exchangeId: "44444444-4444-4444-8444-444444444444",
            turns: [
              { role: "user", text: "an old question", ageSeconds: OVER_WINDOW_AGE_SECONDS },
              { role: "assistant", text: "an old answer", ageSeconds: OVER_WINDOW_AGE_SECONDS - 10 },
            ],
            facts: [{ factId: "fact-old-turn", table: "tech_decisions", createdAtSeconds: 1_000 }],
          },
        ],
      });
    }

    test("rejects when the case is not tagged long_window_not_production_reachable", async () => {
      const { filePath } = await writeFixture(dir, "rule5-reject.jsonl", [makeOldTurnCase("pg-rule5-reject", ["production_reachable"])]);
      const violations = await expectRejected(filePath);
      expect(violations).toContainEqual(expect.objectContaining({ id: "pg-rule5-reject", rule: "turn_beyond_window" }));
    });

    test("does not reject when the case is tagged long_window_not_production_reachable", async () => {
      const { filePath } = await writeFixture(dir, "rule5-control.jsonl", [makeOldTurnCase("pg-rule5-control", ["production_reachable", "long_window_not_production_reachable"])]);
      const result = await loadProvenanceFixture(filePath, []);
      expect(result).toHaveLength(1);
    });
  });

  // T1B — run the loader for real, against the actually-committed dev fixture
  // and the real tier-c/tier-b reference corpora (T1's tests above use only
  // synthetic corpora and synthetic fixtures; per AUTHORING.md, no 5-gram
  // overlap check has ever been run for this fixture before this block).
  //
  // The fixture is read-only this cycle (fixture-brief independence rules):
  // nothing here edits pges-fixture.dev.jsonl or loosens a checker rule.
  //
  // Sealed-file handling: REQ-15 requires verifying BOTH files' SHA-256, but
  // this cycle must not load or run the sealed half (reserved for gate G1,
  // cycle 2 — see the backlog and the fixture brief's independence rules).
  // The owner decision (run.json acknowledgements, attached to both T1 and
  // T1B, and reaffirmed by P8's acknowledgement: "One reference to
  // pges-fixture.sealed.jsonl is permitted: a hash-only SHA-256 verification
  // that streams its bytes") resolves this: verify the sealed sidecar with
  // the standalone, exported `verifyCommittedSha256` only — the same
  // hash-stream-and-compare routine `loadProvenanceFixture` uses internally
  // for the dev file, called here directly so it never proceeds to parse or
  // check-rule the sealed file's cases. The mismatch branch of that function
  // is exercised on a synthetic temp file only (below), never on the sealed
  // file itself, per that same owner decision.
  describe("T1B — real committed dev-half fixture (first real run of REQ-15's checker)", () => {
    // Resolved from this test file's own URL (not import.meta.dirname / a
    // hardcoded absolute path), so it works the same under tsx and under
    // vitest's transform, and does not depend on the process's cwd.
    const provenanceDir = fileURLToPath(new URL("../../evals/datasets/provenance/", import.meta.url));
    const devPath = join(provenanceDir, "pges-fixture.dev.jsonl");
    const sealedPath = join(provenanceDir, "pges-fixture.sealed.jsonl");
    const goldenDir = fileURLToPath(new URL("../../evals/datasets/golden/", import.meta.url));
    const tierCPath = join(goldenDir, "tier-c.jsonl");
    // REQ-15 says "any Tier-B dataset"; datasets/developer/ holds exactly one
    // file (tier-b.jsonl) besides its .gitkeep, so that is the whole set.
    const developerDir = fileURLToPath(new URL("../../evals/datasets/developer/", import.meta.url));
    const tierBPath = join(developerDir, "tier-b.jsonl");

    // AUTHORING.md's per-family "Dev case numbers" column, transcribed by
    // hand from its split table — independent of this loader's own output,
    // so this is a real cross-check and not a tautology against T1B's run.
    const EXPECTED_DEV_IDS = [
      "pg-dormant_sole-2",
      "pg-dormant_sole-3",
      "pg-contested_unattested-1",
      "pg-contested_unattested-2",
      "pg-contested_attested-1",
      "pg-contested_attested-4",
      "pg-multi_distinct_keys-1",
      "pg-multi_distinct_keys-4",
      "pg-decision_domain-2",
      "pg-decision_domain-3",
      "pg-todo_only-2",
      "pg-reviewed_obsolete-2",
      "pg-reviewed_obsolete-3",
      "pg-conflict_only-3",
      "pg-successor_absent-1",
      "pg-successor_chain-1",
      "pg-mixed_exchange-3",
      "pg-suppressed_no_conflict-2",
      "pg-suppressed_successor-2",
      "pg-created_at_inversion-1",
      "pg-created_at_inversion-2",
      "pg-partner_completion-3",
      "pg-split_key_leak-1",
      "pg-split_key_leak-3",
      "pg-unreviewed_same_key-1",
      "pg-older_authoritative_newer_draft-2",
      "pg-older_authoritative_newer_draft-3",
      "pg-noise_only_leak-1",
      "pg-low_similarity_decision-2",
      "pg-failed_write-2",
      "pg-lookup_error-1",
      "pg-malformed_rows-1",
      "pg-foreign_rows-2",
      "pg-duplicate_fact_id-1",
      "pg-no_exchange_ids-1",
      "pg-no_exchange_ids-2",
      "pg-unbound_mixed-1",
      "pg-foreign_scope-2",
      "pg-equal_similarity-1",
    ];

    test("the real tier-c/tier-b reference corpora are non-empty (so a clean rule-1 pass cannot be a vacuous empty-set match)", async () => {
      const [tierC, tierB] = await Promise.all([fsp.stat(tierCPath), fsp.stat(tierBPath)]);
      expect(tierC.size).toBeGreaterThan(0);
      expect(tierB.size).toBeGreaterThan(0);
    });

    test("accepts all 39 committed dev-half cases — verifies the dev file's SHA-256 sidecar and runs all five REQ-15 rules, including the first-ever rule-1 5-gram check against the real tier-c/tier-b corpora", async () => {
      const cases = await loadProvenanceFixture(devPath, [tierCPath, tierBPath]);
      expect(cases).toHaveLength(39);
      expect(cases.map((c) => c.id).sort()).toEqual([...EXPECTED_DEV_IDS].sort());
    });

    test("verifies the committed dev file's SHA-256 sidecar directly, via the same standalone check used below on the sealed sidecar", async () => {
      await expect(verifyCommittedSha256(devPath)).resolves.toBeUndefined();
    });

    test("verifies the sealed file's SHA-256 sidecar — hash-only, streamed bytes compared to the committed digest, never loaded, parsed, printed, or logged (REQ-15 'verify both files'; owner decision)", async () => {
      // This call is the one place in this cycle's new code that names
      // pges-fixture.sealed.jsonl, and it goes only through
      // verifyCommittedSha256 — never loadProvenanceFixture, readFileSync, or
      // any other reader of its content. Loading and rule-checking the sealed
      // half is gate G1, cycle 2.
      await expect(verifyCommittedSha256(sealedPath)).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// T7A -- ProvenanceCase -> provenance-select.ts's inputs (REQ-15 layer (a))
//
// Hand-built cases only (per the task: unit-test the translator directly),
// plus one read-only smoke pass over the real 39 committed dev-half cases
// (shape invariants only -- never a selectWithProvenance run against
// `expect`; that scoring is T7B's job). Nothing here loads or references
// the sealed half.
// ---------------------------------------------------------------------------

function md5(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/** A minimal, schema-shaped case for translator tests -- not run through loadProvenanceFixture's rule 1-5 checks, since these tests exercise the translator directly. */
function t7aCase(overrides: Partial<ProvenanceCase> = {}): ProvenanceCase {
  return {
    id: "pg-t7a-test",
    tags: ["production_reachable"],
    conversation: { orgId: "org-1", keyId: "key-1", sessionId: "sess-1", projectScopeId: "acme/widget" },
    windowMs: 7_200_000,
    nowSeconds: 1_000_000,
    query: "widget publish retry timeout",
    exchanges: [],
    unboundTurns: [],
    reviewedLinks: [],
    foreign: [],
    lookupFault: null,
    expect: {
      fallback: null,
      sameAsBase: false,
      requiredExchangeIds: [],
      forbiddenExchangeIds: [],
      notAddedExchangeIds: [],
      notRemovedExchangeIds: [],
      pinnedLimitation: [],
      derivation: {},
    },
    ...overrides,
  };
}

describe("T7A -- lexical tokenization + similarity (the frozen layer-(a) scheme)", () => {
  test("query tokens: lowercased, split on the brief's char class, length>=3, stopwords dropped", () => {
    // No trailing punctuation on a kept word: "." is itself part of the
    // brief's token character class (so file paths / versions tokenize as
    // one run), so a sentence-ending period would attach to "it" as "it." --
    // correct tokenizer behavior, just not what this test means to check.
    const tokens = lexicalQueryTokens("Retry the widget publish after a timeout and log it");
    expect([...tokens].sort()).toEqual(["after", "log", "publish", "retry", "timeout", "widget"].sort());
  });

  test("query tokens: capped to the first 16 AFTER filtering (not before)", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo"];
    const tokens = lexicalQueryTokens(words.join(" "));
    expect(tokens.size).toBe(16);
    expect(tokens.has("papa")).toBe(true); // 16th qualifying token
    expect(tokens.has("quebec")).toBe(false); // 17th -- dropped by the cap
    expect(tokens.has("romeo")).toBe(false); // 18th -- dropped by the cap
  });

  test("query tokens: cut to 1,200 characters BEFORE splitting", () => {
    const filler = "x".repeat(1_195); // pushes the marker word past char 1200
    const tokens = lexicalQueryTokens(`${filler} markerword`);
    expect(tokens.has("markerword")).toBe(false);
  });

  test("query tokens: deduped to a set", () => {
    const tokens = lexicalQueryTokens("widget widget widget");
    expect(tokens.size).toBe(1);
    expect(tokens.has("widget")).toBe(true);
  });

  test("turn tokens: same split/length/stopword rule, but NO 1,200-char cut and NO 16-token cap", () => {
    const words = Array.from({ length: 20 }, (_, i) => `token${i}`); // 20 distinct, all length>=3, none stopwords
    const tokens = lexicalTurnTokens(words.join(" "));
    expect(tokens.size).toBe(20);
  });

  test("similarity: |Q intersect T| / sqrt(|Q| x |T|); 0 when either set is empty", () => {
    expect(lexicalSimilarity(new Set(), new Set())).toBe(0);
    expect(lexicalSimilarity(new Set(["a", "b"]), new Set())).toBe(0);
    expect(lexicalSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(lexicalSimilarity(new Set(["a", "b", "c"]), new Set(["a"]))).toBeCloseTo(1 / Math.sqrt(3), 10);
  });
});

describe("T7A -- translateProvenanceCase: history (turns -> history entries)", () => {
  test("bound + unbound turns merge into one array, oldest-first, timestampSeconds = nowSeconds - ageSeconds", () => {
    const c = t7aCase({
      nowSeconds: 1_000_000,
      exchanges: [
        {
          exchangeId: "ex-a",
          write: "ok",
          turns: [
            { role: "user", text: "question a", ageSeconds: 500 },
            { role: "assistant", text: "answer a", ageSeconds: 490 },
          ],
          facts: [],
        },
      ],
      unboundTurns: [{ role: "user", text: "legacy turn", ageSeconds: 700 }],
    });
    const t = translateProvenanceCase(c);
    expect(t.history).toHaveLength(3);
    // oldest-first: age 700 (ts=999300) < age 500 (ts=999500) < age 490 (ts=999510)
    expect(t.history.map((h) => h.timestampSeconds)).toEqual([999_300, 999_500, 999_510]);
    expect(t.history[0]?.exchangeId).toBeUndefined(); // the unbound turn landed first
    expect(t.history[1]?.exchangeId).toBe("ex-a");
    expect(t.history[2]?.exchangeId).toBe("ex-a");
  });

  test("unboundHistoryIndices maps unboundTurns[i] to its post-sort position in history", () => {
    const c = t7aCase({
      nowSeconds: 1_000_000,
      exchanges: [{ exchangeId: "ex-a", write: "ok", turns: [{ role: "user", text: "middle", ageSeconds: 400 }], facts: [] }],
      unboundTurns: [
        { role: "user", text: "oldest", ageSeconds: 900 },
        { role: "user", text: "newest", ageSeconds: 100 },
      ],
    });
    const t = translateProvenanceCase(c);
    expect(t.history).toHaveLength(3);
    expect(t.unboundHistoryIndices).toHaveLength(2);
    const [oldestIdx, newestIdx] = t.unboundHistoryIndices;
    expect(t.history[oldestIdx!]?.timestampSeconds).toBe(1_000_000 - 900);
    expect(t.history[oldestIdx!]?.exchangeId).toBeUndefined();
    expect(t.history[newestIdx!]?.timestampSeconds).toBe(1_000_000 - 100);
    expect(t.history[newestIdx!]?.exchangeId).toBeUndefined();
  });

  test("nowSeconds is required -- the translator never falls back to the wall clock", () => {
    const c = t7aCase();
    delete (c as { nowSeconds?: number }).nowSeconds;
    expect(() => translateProvenanceCase(c)).toThrow(/nowSeconds/);
  });

  test("foreign entries never contribute turns to history, even when their scopeId equals the case's own scope (the same-scope trap)", () => {
    const c = t7aCase({
      conversation: { orgId: "org-1", keyId: "key-1", sessionId: "sess-1", projectScopeId: "acme/widget" },
      exchanges: [{ exchangeId: "ex-a", write: "ok", turns: [{ role: "user", text: "local", ageSeconds: 100, scopeId: "acme/widget" }], facts: [] }],
      foreign: [
        {
          relation: "other_conversation",
          conversation: { orgId: "org-1", keyId: "key-1", sessionId: "sess-2", projectScopeId: "acme/widget" }, // SAME scope on purpose
          exchangeId: "foreign-ex-1",
          write: "ok",
          turns: [{ role: "user", text: "foreign turn", ageSeconds: 50, scopeId: "acme/widget" }],
          facts: [],
        },
      ],
    });
    const t = translateProvenanceCase(c);
    expect(t.history.some((h) => h.exchangeId === "foreign-ex-1")).toBe(false);
    expect(t.history).toHaveLength(1);
  });
});

describe("T7A -- translateProvenanceCase: queryScopeId (from conversation.projectScopeId)", () => {
  test("present projectScopeId -> queryScopeId", () => {
    const t = translateProvenanceCase(t7aCase({ conversation: { orgId: "o", keyId: "k", sessionId: "s", projectScopeId: "acme/widget" } }));
    expect(t.queryScopeId).toBe("acme/widget");
  });

  test("conversation absent -> queryScopeId undefined", () => {
    const c = t7aCase();
    delete (c as { conversation?: unknown }).conversation;
    const t = translateProvenanceCase(c);
    expect(t.queryScopeId).toBeUndefined();
  });

  test("projectScopeId: null (unbound session) -> queryScopeId undefined", () => {
    const t = translateProvenanceCase(t7aCase({ conversation: { orgId: "o", keyId: "k", sessionId: "s", projectScopeId: null } }));
    expect(t.queryScopeId).toBeUndefined();
  });
});

describe("T7A -- translateProvenanceCase: facts -> provenance-snapshot rows", () => {
  test("keyHashes = md5(lower(btrim(field))) per table; function_changes hashes BOTH old_name and new_name", () => {
    const c = t7aCase({
      exchanges: [
        {
          exchangeId: "ex-a",
          write: "ok",
          turns: [{ role: "user", text: "rename", ageSeconds: 100 }],
          facts: [
            {
              factId: "fact-fc",
              table: "function_changes",
              fields: { old_name: "  ComputeInvoice  ", new_name: "CalculateInvoice" },
              createdAtSeconds: 900,
            },
          ],
        },
      ],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const row = rows.find((r) => r.factId === "fact-fc");
    expect(row?.keyHashes.sort()).toEqual([md5("computeinvoice"), md5("calculateinvoice")].sort());
  });

  test("btrim+lowercase normalize before hashing: '  Maps  ' and 'maps' hash identically", () => {
    const c = t7aCase({
      exchanges: [
        {
          exchangeId: "ex-a",
          write: "ok",
          turns: [{ role: "user", text: "a", ageSeconds: 200 }],
          facts: [{ factId: "fact-1", table: "tech_decisions", fields: { domain: "  Maps  ", decision_text: "x" }, createdAtSeconds: 100 }],
        },
        {
          exchangeId: "ex-b",
          write: "ok",
          turns: [{ role: "user", text: "b", ageSeconds: 190 }],
          facts: [{ factId: "fact-2", table: "tech_decisions", fields: { domain: "maps", decision_text: "y" }, createdAtSeconds: 100 }],
        },
      ],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const h1 = rows.find((r) => r.factId === "fact-1")?.keyHashes[0];
    const h2 = rows.find((r) => r.factId === "fact-2")?.keyHashes[0];
    expect(h1).toBeDefined();
    expect(h1).toBe(h2);
  });

  test("todos never carry a key hash", () => {
    const c = t7aCase({
      exchanges: [
        {
          exchangeId: "ex-a",
          write: "ok",
          turns: [{ role: "user", text: "a", ageSeconds: 100 }],
          facts: [{ factId: "fact-todo", table: "todos", fields: { description: "do a thing", status: "open" }, createdAtSeconds: 100 }],
        },
      ],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    expect(rows.find((r) => r.factId === "fact-todo")?.keyHashes).toEqual([]);
  });

  test("active = !isSuppressed (absent -> active); auditStatus passthrough (absent -> null); queryMatch from matchesQuery (absent -> false)", () => {
    const c = t7aCase({
      exchanges: [
        {
          exchangeId: "ex-a",
          write: "ok",
          turns: [{ role: "user", text: "a", ageSeconds: 100 }],
          facts: [
            { factId: "f1", table: "tech_decisions", fields: { domain: "d1" }, createdAtSeconds: 100, isSuppressed: true, auditStatus: "CONFLICT", matchesQuery: true },
            { factId: "f2", table: "tech_decisions", fields: { domain: "d2" }, createdAtSeconds: 100 },
          ],
        },
      ],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const r1 = rows.find((r) => r.factId === "f1")!;
    const r2 = rows.find((r) => r.factId === "f2")!;
    expect(r1.active).toBe(false);
    expect(r1.auditStatus).toBe("CONFLICT");
    expect(r1.queryMatch).toBe(true);
    expect(r2.active).toBe(true);
    expect(r2.auditStatus).toBeNull();
    expect(r2.queryMatch).toBe(false);
  });
});

describe("T7A -- translateProvenanceCase: reviewedObsolete / successorExchangeId", () => {
  test("a resolved local link marks the older fact reviewedObsolete, with the newer fact's own exchange as successor", () => {
    const c = t7aCase({
      exchanges: [
        { exchangeId: "ex-old", write: "ok", turns: [{ role: "user", text: "old", ageSeconds: 500 }], facts: [{ factId: "old-fact", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }] },
        { exchangeId: "ex-new", write: "ok", turns: [{ role: "user", text: "new", ageSeconds: 200 }], facts: [{ factId: "new-fact", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 900 }] },
      ],
      reviewedLinks: [{ newerFactId: "new-fact", olderFactId: "old-fact", reviewer: "abc", evidence: "some evidence text over 20 chars" }],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const oldRow = rows.find((r) => r.factId === "old-fact")!;
    const newRow = rows.find((r) => r.factId === "new-fact")!;
    expect(oldRow.reviewedObsolete).toBe(true);
    expect(oldRow.successorExchangeId).toBe("ex-new");
    expect(newRow.reviewedObsolete).toBe(false);
    expect(newRow.successorExchangeId).toBeUndefined();
  });

  test("db_rejects disables EVERY reviewedLinks entry in the case -- no fact becomes reviewedObsolete", () => {
    const c = t7aCase({
      tags: ["production_reachable", "db_rejects"],
      exchanges: [
        { exchangeId: "ex-old", write: "ok", turns: [{ role: "user", text: "old", ageSeconds: 500 }], facts: [{ factId: "old-fact", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }] },
        { exchangeId: "ex-new", write: "ok", turns: [{ role: "user", text: "new", ageSeconds: 200 }], facts: [{ factId: "new-fact", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 900 }] },
      ],
      reviewedLinks: [{ newerFactId: "new-fact", olderFactId: "old-fact", reviewer: "abc", evidence: "some evidence text over 20 chars" }],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const oldRow = rows.find((r) => r.factId === "old-fact")!;
    expect(oldRow.reviewedObsolete).toBe(false);
    expect(oldRow.successorExchangeId).toBeUndefined();
  });

  test("other_conversation: a successor that resolves only to a foreign fact of relation 'other_conversation' stays reviewedObsolete but gets NO successorExchangeId (REQ-12: same-session only)", () => {
    const c = t7aCase({
      exchanges: [{ exchangeId: "ex-old", write: "ok", turns: [{ role: "user", text: "old", ageSeconds: 500 }], facts: [{ factId: "old-fact", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }] }],
      foreign: [
        {
          relation: "other_conversation",
          conversation: { orgId: "o", keyId: "k", sessionId: "s2", projectScopeId: "acme/widget" },
          exchangeId: "foreign-ex",
          write: "ok",
          turns: [{ role: "user", text: "elsewhere", ageSeconds: 50 }],
          facts: [{ factId: "new-fact-foreign", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 900 }],
        },
      ],
      reviewedLinks: [{ newerFactId: "new-fact-foreign", olderFactId: "old-fact", reviewer: "abc", evidence: "some evidence text over 20 chars" }],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const oldRow = rows.find((r) => r.factId === "old-fact")!;
    expect(oldRow.reviewedObsolete).toBe(true);
    expect(oldRow.successorExchangeId).toBeUndefined();
  });

  test("two links naming the same olderFactId: the FIRST in reviewedLinks order wins", () => {
    const c = t7aCase({
      exchanges: [
        { exchangeId: "ex-old", write: "ok", turns: [{ role: "user", text: "old", ageSeconds: 500 }], facts: [{ factId: "old-fact", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }] },
        { exchangeId: "ex-first", write: "ok", turns: [{ role: "user", text: "first", ageSeconds: 300 }], facts: [{ factId: "first-fact", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 800 }] },
        { exchangeId: "ex-second", write: "ok", turns: [{ role: "user", text: "second", ageSeconds: 200 }], facts: [{ factId: "second-fact", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 900 }] },
      ],
      reviewedLinks: [
        { newerFactId: "first-fact", olderFactId: "old-fact", reviewer: "abc", evidence: "evidence text over twenty chars" },
        { newerFactId: "second-fact", olderFactId: "old-fact", reviewer: "def", evidence: "other evidence text over twenty" },
      ],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    expect(rows.find((r) => r.factId === "old-fact")?.successorExchangeId).toBe("ex-first");
  });

  test("REQ-5: an unreviewed, model-extracted supersedes_id never marks a fact reviewedObsolete on its own", () => {
    const c = t7aCase({
      exchanges: [
        {
          exchangeId: "ex-a",
          write: "ok",
          turns: [{ role: "user", text: "a", ageSeconds: 100 }],
          facts: [{ factId: "fact-1", table: "tech_decisions", fields: { domain: "d", decision_text: "x", supersedes_id: "some-other-fact-id" }, createdAtSeconds: 100 }],
        },
      ],
      reviewedLinks: [], // no reviewed link at all -- only the raw model-extracted field
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const row = rows.find((r) => r.factId === "fact-1")!;
    expect(row.reviewedObsolete).toBe(false);
    expect(row.successorExchangeId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D2 (reviewer-found defect, phase1-010-v04-provenance-1a): the harness used
// to honor a reviewedLinks successor found anywhere in `c.foreign`, regardless
// of scope -- but the real RPC's NOT EXISTS predicate
// (supabase/migrations/20260924235700, 20260924235800) scopes the successor
// join to `org_id = match_org AND project_scope IS NOT DISTINCT FROM
// match_project_scope`, with no `session_id` filter on the successor side. So
// a same-org/same-project successor in a DIFFERENT session ("other_conversation")
// still marks the older fact dead (AUTHORING.md interpretation choice #2: "By
// the brief's dead-fact rule (same org and project), the stale fact is dead"),
// while a successor in another project or another org does not. One test per
// `ProvenanceForeignExchange.relation` value, each with a non-db_rejects link
// naming that foreign fact as successor. Against the pre-fix function, only
// other_project/other_org are expected to flip (today it treats every
// non-local successor as obsolete); local/other_conversation already pass and
// guard against a regression.
// ---------------------------------------------------------------------------
describe("D2 -- translateProvenanceCase: reviewedObsolete keyed on the foreign successor's own relation", () => {
  test("local: successor resolves inside this case's own exchanges -> reviewedObsolete true, successorExchangeId set", () => {
    const c = t7aCase({
      exchanges: [
        { exchangeId: "ex-old-local", write: "ok", turns: [{ role: "user", text: "old", ageSeconds: 500 }], facts: [{ factId: "old-fact-local", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }] },
        { exchangeId: "ex-new-local", write: "ok", turns: [{ role: "user", text: "new", ageSeconds: 200 }], facts: [{ factId: "new-fact-local", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 900 }] },
      ],
      reviewedLinks: [{ newerFactId: "new-fact-local", olderFactId: "old-fact-local", reviewer: "abc", evidence: "some evidence text over 20 chars" }],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const oldRow = rows.find((r) => r.factId === "old-fact-local")!;
    expect(oldRow.reviewedObsolete).toBe(true);
    expect(oldRow.successorExchangeId).toBe("ex-new-local");
  });

  test("other_conversation: successor resolves to a `foreign` entry tagged relation:'other_conversation' -> reviewedObsolete true, successorExchangeId null", () => {
    const c = t7aCase({
      exchanges: [{ exchangeId: "ex-old-conv", write: "ok", turns: [{ role: "user", text: "old", ageSeconds: 500 }], facts: [{ factId: "old-fact-conv", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }] }],
      foreign: [
        {
          relation: "other_conversation",
          conversation: { orgId: "org-1", keyId: "key-1", sessionId: "sess-2", projectScopeId: "acme/widget" },
          exchangeId: "foreign-ex-conv",
          write: "ok",
          turns: [{ role: "user", text: "elsewhere", ageSeconds: 50 }],
          facts: [{ factId: "new-fact-conv", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 900 }],
        },
      ],
      reviewedLinks: [{ newerFactId: "new-fact-conv", olderFactId: "old-fact-conv", reviewer: "abc", evidence: "some evidence text over 20 chars" }],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const oldRow = rows.find((r) => r.factId === "old-fact-conv")!;
    expect(oldRow.reviewedObsolete).toBe(true);
    expect(oldRow.successorExchangeId).toBeUndefined();
  });

  test("other_project: successor resolves to a `foreign` entry tagged relation:'other_project' -> reviewedObsolete false", () => {
    const c = t7aCase({
      exchanges: [{ exchangeId: "ex-old-proj", write: "ok", turns: [{ role: "user", text: "old", ageSeconds: 500 }], facts: [{ factId: "old-fact-proj", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }] }],
      foreign: [
        {
          relation: "other_project",
          conversation: { orgId: "org-1", keyId: "key-1", sessionId: "sess-3", projectScopeId: "acme/other-widget" },
          exchangeId: "foreign-ex-proj",
          write: "ok",
          turns: [{ role: "user", text: "elsewhere", ageSeconds: 50 }],
          facts: [{ factId: "new-fact-proj", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 900 }],
        },
      ],
      reviewedLinks: [{ newerFactId: "new-fact-proj", olderFactId: "old-fact-proj", reviewer: "abc", evidence: "some evidence text over 20 chars" }],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const oldRow = rows.find((r) => r.factId === "old-fact-proj")!;
    expect(oldRow.reviewedObsolete).toBe(false);
    expect(oldRow.successorExchangeId).toBeUndefined();
  });

  test("other_org: successor resolves to a `foreign` entry tagged relation:'other_org' -> reviewedObsolete false", () => {
    const c = t7aCase({
      exchanges: [{ exchangeId: "ex-old-org", write: "ok", turns: [{ role: "user", text: "old", ageSeconds: 500 }], facts: [{ factId: "old-fact-org", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }] }],
      foreign: [
        {
          relation: "other_org",
          conversation: { orgId: "org-2", keyId: "key-9", sessionId: "sess-9", projectScopeId: "acme/widget" },
          exchangeId: "foreign-ex-org",
          write: "ok",
          turns: [{ role: "user", text: "elsewhere", ageSeconds: 50 }],
          facts: [{ factId: "new-fact-org", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 900 }],
        },
      ],
      reviewedLinks: [{ newerFactId: "new-fact-org", olderFactId: "old-fact-org", reviewer: "abc", evidence: "some evidence text over 20 chars" }],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const oldRow = rows.find((r) => r.factId === "old-fact-org")!;
    expect(oldRow.reviewedObsolete).toBe(false);
    expect(oldRow.successorExchangeId).toBeUndefined();
  });

  // Tester-added (T2 QA): the task's own defensive-default branch --
  // "a successor factId found in neither map (untagged/unresolved) ->
  // reviewedObsolete false (fail closed per REQ-2's philosophy" -- had zero
  // coverage from the coder's 4 new tests (all four named a real local or
  // foreign home for the successor). This is also a THIRD case, beyond the
  // task's named other_project/other_org, that the pre-fix function actually
  // got wrong: its old "any non-local successor is obsolete" rule marked an
  // utterly unresolvable factId obsolete too, since it never distinguished
  // "resolved to a scoped-out foreign entry" from "resolves nowhere at all".
  test("unresolved: successor factId is not this case's own local fact and not in any foreign entry -> reviewedObsolete false (fails closed, REQ-2)", () => {
    const c = t7aCase({
      exchanges: [{ exchangeId: "ex-old-unresolved", write: "ok", turns: [{ role: "user", text: "old", ageSeconds: 500 }], facts: [{ factId: "old-fact-unresolved", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }] }],
      // No `foreign` entries at all -- the named successor resolves in neither map.
      reviewedLinks: [{ newerFactId: "phantom-fact-nowhere", olderFactId: "old-fact-unresolved", reviewer: "abc", evidence: "some evidence text over 20 chars" }],
    });
    const t = translateProvenanceCase(c);
    const rows = t.snapshot.lookup.kind === "ok" ? t.snapshot.lookup.rows : [];
    const oldRow = rows.find((r) => r.factId === "old-fact-unresolved")!;
    expect(oldRow.reviewedObsolete).toBe(false);
    expect(oldRow.successorExchangeId).toBeUndefined();
  });
});

describe("T7A -- translateProvenanceCase: write -> failedExchangeIds", () => {
  test("write:'failed' on a local exchange lands in failedExchangeIds; 'ok'/absent do not", () => {
    const c = t7aCase({
      exchanges: [
        { exchangeId: "ex-failed", write: "failed", turns: [{ role: "user", text: "a", ageSeconds: 100 }], facts: [] },
        { exchangeId: "ex-ok", write: "ok", turns: [{ role: "user", text: "b", ageSeconds: 90 }], facts: [] },
      ],
    });
    const t = translateProvenanceCase(c);
    expect(t.snapshot.failedExchangeIds.has("ex-failed")).toBe(true);
    expect(t.snapshot.failedExchangeIds.has("ex-ok")).toBe(false);
  });

  test("a foreign exchange's write is never consulted, even when 'failed'", () => {
    const c = t7aCase({
      exchanges: [{ exchangeId: "ex-a", write: "ok", turns: [{ role: "user", text: "a", ageSeconds: 100 }], facts: [] }],
      foreign: [
        {
          relation: "other_conversation",
          conversation: { orgId: "o", keyId: "k", sessionId: "s2", projectScopeId: "acme/widget" },
          exchangeId: "foreign-ex",
          write: "failed",
          turns: [{ role: "user", text: "x", ageSeconds: 50 }],
          facts: [],
        },
      ],
    });
    const t = translateProvenanceCase(c);
    expect(t.snapshot.failedExchangeIds.has("foreign-ex")).toBe(false);
  });
});

describe("T7A -- translateProvenanceCase: lookupFault, verified end-to-end through the real selectWithProvenance", () => {
  function runSelector(c: ProvenanceCase) {
    const t = translateProvenanceCase(c);
    return selectWithProvenance(t.queryEmbedding, t.history, t.params, t.queryScopeId, t.snapshot).provenance;
  }

  const oneExchangeCase = (extra: Partial<ProvenanceCase> = {}) =>
    t7aCase({
      // Every turn's scopeId matches the conversation's projectScopeId, exactly
      // as every real fixture turn does -- otherwise prune()'s own REQ-4 scope
      // filter (which selectWithProvenance applies before anything else) would
      // exclude the turn from the window and mask these tests behind a
      // spurious NO_EXCHANGE_IDS, unrelated to whatever this test means to check.
      exchanges: [
        {
          exchangeId: "ex-a",
          write: "ok",
          turns: [
            { role: "user", text: "a", ageSeconds: 100, scopeId: "acme/widget" },
            { role: "assistant", text: "b", ageSeconds: 90, scopeId: "acme/widget" },
          ],
          facts: [{ factId: "f1", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }],
        },
      ],
      ...extra,
    });

  test("lookupFault: null -> guards pass (reason null)", () => {
    expect(runSelector(oneExchangeCase({ lookupFault: null })).reason).toBeNull();
  });

  test("lookupFault: 'reject' -> LOOKUP_ERROR", () => {
    expect(runSelector(oneExchangeCase({ lookupFault: "reject" })).reason).toBe("LOOKUP_ERROR");
  });

  test("lookupFault: 'timeout' -> LOOKUP_ERROR", () => {
    expect(runSelector(oneExchangeCase({ lookupFault: "timeout" })).reason).toBe("LOOKUP_ERROR");
  });

  test("lookupFault: 'malformed' -> LOOKUP_INVALID", () => {
    expect(runSelector(oneExchangeCase({ lookupFault: "malformed" })).reason).toBe("LOOKUP_INVALID");
  });

  test("lookupFault: 'duplicate_fact_id' -> LOOKUP_INVALID", () => {
    expect(runSelector(oneExchangeCase({ lookupFault: "duplicate_fact_id" })).reason).toBe("LOOKUP_INVALID");
  });

  test("lookupFault: 'foreign_row' -> LOOKUP_INVALID (the injected row carries foreign[0]'s own out-of-window exchangeId)", () => {
    const c = oneExchangeCase({
      lookupFault: "foreign_row",
      foreign: [
        {
          relation: "other_project",
          conversation: { orgId: "o", keyId: "k", sessionId: "s2", projectScopeId: "acme/other" },
          exchangeId: "foreign-ex",
          write: "ok",
          turns: [{ role: "user", text: "x", ageSeconds: 50 }],
          facts: [{ factId: "foreign-fact", table: "tech_decisions", fields: { domain: "d" }, createdAtSeconds: 100 }],
        },
      ],
    });
    expect(runSelector(c).reason).toBe("LOOKUP_INVALID");
  });

  test("write:'failed' -> WRITE_FAILED (through the real selector)", () => {
    expect(runSelector(oneExchangeCase({ exchanges: [{ exchangeId: "ex-a", write: "failed", turns: [{ role: "user", text: "a", ageSeconds: 100, scopeId: "acme/widget" }], facts: [] }] })).reason).toBe("WRITE_FAILED");
  });
});

describe("T7A -- translator smoke over the real 39 committed dev-half cases (shape invariants only, never scored against expect)", () => {
  const provenanceDir = fileURLToPath(new URL("../../evals/datasets/provenance/", import.meta.url));
  const devPath = join(provenanceDir, "pges-fixture.dev.jsonl");

  test("every dev case translates without throwing, with sane shape invariants", async () => {
    const cases = await loadProvenanceFixture(devPath, []);
    expect(cases).toHaveLength(39);

    for (const c of cases) {
      const t = translateProvenanceCase(c);

      // oldest-first: timestamps never decrease.
      for (let i = 1; i < t.history.length; i++) {
        expect(t.history[i]!.timestampSeconds).toBeGreaterThanOrEqual(t.history[i - 1]!.timestampSeconds);
      }

      // A foreign exchangeId must never appear as a bound history turn.
      const foreignExchangeIds = new Set(c.foreign.map((f) => f.exchangeId).filter((x): x is string => typeof x === "string"));
      for (const h of t.history) {
        if (h.exchangeId !== undefined) expect(foreignExchangeIds.has(h.exchangeId)).toBe(false);
      }

      // Unfaulted lookups: every row belongs to one of this case's own local exchanges, and todos never carry a key hash.
      if ((c.lookupFault ?? null) === null && t.snapshot.lookup.kind === "ok") {
        const localExchangeIds = new Set(c.exchanges.map((e) => e.exchangeId));
        for (const row of t.snapshot.lookup.rows) {
          expect(localExchangeIds.has(row.exchangeId)).toBe(true);
          if (row.factTable === "todos") expect(row.keyHashes).toEqual([]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T7B -- score every dev-half case's REAL selectWithProvenance output against
// its own expect/predicted/anchors blocks. T7A's translator + T1's loader
// feed this; see evals/harness/provenance-fixture.ts's own T7B header comment
// for the full scoring contract and the owner decisions (run.json
// acknowledgements, 2026-09-26) it implements. This block only ever loads and
// scores the dev half; the fixture's other, held-out half stays untouched.
//
// Red-first ritual (recorded once, not re-run every suite pass): before
// wiring the real selectWithProvenance into the per-case tests below, this
// cycle ran the SAME 39 cases through `alwaysBaseDecisionStub` just below --
// a stub that always returns the base decision unchanged (NO_SNAPSHOT) -- and
// captured that red run's vitest output verbatim, then swapped in the real
// function and captured the after run too. Both logs, plus the printed
// report from the "reports all 39" test below, back this cycle's proof note.
// The stub itself stays defined and pinned by one small test so it cannot
// silently bit-rot into meaning something else.
// ---------------------------------------------------------------------------

describe("T7B -- score every dev-half case against expect/predicted/anchors (layer (a): T7A's frozen lexical similarity)", () => {
  const provenanceDir = fileURLToPath(new URL("../../evals/datasets/provenance/", import.meta.url));
  const devPath = join(provenanceDir, "pges-fixture.dev.jsonl");

  // Enumerated straight from the committed dev file's own `id` fields (never
  // hand-copied, never touches the "T1B" describe block's own
  // EXPECTED_DEV_IDS above) purely to give test.each a synchronous list of
  // test names at collection time. The real load -- SHA-256 sidecar check +
  // every REQ-15 rule -- still happens exactly once, inside beforeAll below,
  // through the real loadProvenanceFixture.
  const DEV_CASE_IDS: string[] = readFileSync(devPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { id: string }).id);

  /**
   * Red-first stub (T7B): always returns the base decision unchanged by
   * forcing NO_SNAPSHOT (never passing a snapshot through) -- reuses the
   * real selectWithProvenance underneath rather than reimplementing prune()
   * separately, so it is exactly "the base decision, unchanged" and nothing
   * else. Used once, manually, to confirm most of the 39 cases go red before
   * the real function is wired into the per-case tests below (see this
   * block's own header and the proof note); pinned by the test right below
   * so it keeps compiling and behaving exactly as documented.
   */
  const alwaysBaseDecisionStub: ProvenanceSelector = (queryEmbedding, history, params, queryScopeId) => selectWithProvenance(queryEmbedding, history, params, queryScopeId, undefined);

  let cases: ProvenanceCase[];
  let results: Map<string, ProvenanceDevCaseResult>;

  beforeAll(async () => {
    cases = await loadProvenanceFixture(devPath, []);
    expect(cases).toHaveLength(39);
    results = new Map(cases.map((c) => [c.id, runProvenanceDevCase(c)]));
  });

  test("red-first stub: always reports NO_SNAPSHOT and leaves the decision exactly at the base (pinned so it cannot silently drift)", () => {
    const r = runProvenanceDevCase(cases[0]!, alwaysBaseDecisionStub);
    expect(r.decision.provenance.reason).toBe("NO_SNAPSHOT");
    expect(r.decision.provenance.applied).toBe(false);
    expect(r.decision.selectedIndices).toEqual(r.decision.provenance.baseSelectedIndices);
  });

  /**
   * Cases this cycle's run of the REAL selectWithProvenance is KNOWN to fail
   * under T7A's layer-(a) lexical stand-in, each mapped to exactly the
   * `expect.*` field(s) that fail for it. Verified mechanism, all three: the
   * stand-in scores a "pinned"/contested exchange's two turns asymmetrically
   * enough that the RAW base decision only PARTIALLY selects it, and REQ-10
   * completion then (per its own spec) fills it in -- which flips
   * `selectedIndices` away from `baseSelectedIndices` for an exchange whose
   * `expect` asserts `sameAsBase`.
   *
   * This is NOT a `provenance-select.ts` defect (REQ-10 fired exactly as
   * specified). Whether it is instead a pure layer-(a) artifact (a real
   * encoder would score both turns together and the base would pick both or
   * neither) or the fixture finding AUTHORING.md's own "Interpretation
   * choice #1" pre-registers ("A difference caused only by completion in
   * these cases is a fixture finding, not a candidate failure" -- i.e. a
   * real encoder ALSO picks only one turn, meaning the author's "kept both
   * turns on topic" assumption does not hold for these three) is genuinely
   * UNDETERMINED until layer (b) (the real MiniLM encoder, cycle 2) runs.
   * Either way, this is not something to fix by editing the fixture, this
   * scheme, or `provenance-select.ts` this cycle.
   *
   * Every one of these is ALSO reported as a `predicted.candidate` miss by
   * the "reports all 39" test below -- per the owner decision (run.json
   * acknowledgements) that is a genuine finding to report, never a reason to
   * edit the fixture. This allowlist does not hide the divergence: it pins
   * the EXACT field(s) expected to fail, so either a different field
   * failing, one of these no longer failing, or a NEW, unexplained failure
   * anywhere else is visible instead of silently re-absorbed.
   *
   * T6 (review concern 4): the exact-field pin below used to be a plain,
   * ordinary-passing `test.each(KNOWN_DIVERGENCE_IDS)` -- indistinguishable
   * in the test/vitest output from a genuine pass. It is now
   * `test.skip.each`, titled as a FINDING, so vitest's own summary never
   * folds these three into the suite's ordinary passed count; the pin
   * itself (which `expect.*`/`anchors` field fails for each id) moved into
   * the "reports all 39 dev cases" test below, in its own "Exact-field pin
   * (T6, review concern 4)" block, since a skipped test's body never runs.
   */
  const KNOWN_COMPLETION_DIVERGENCES: Readonly<Record<string, ReadonlyArray<keyof ProvenanceDevCaseResult["candidateScore"]>>> = {
    "pg-contested_unattested-1": ["sameAsBase"],
    "pg-unreviewed_same_key-1": ["sameAsBase", "pinnedLimitation"],
    "pg-noise_only_leak-1": ["pinnedLimitation"],
  };
  const KNOWN_DIVERGENCE_IDS = Object.keys(KNOWN_COMPLETION_DIVERGENCES);
  const NORMAL_CASE_IDS = DEV_CASE_IDS.filter((id) => !(id in KNOWN_COMPLETION_DIVERGENCES));
  const EXPECT_SCORE_FIELDS = ["fallback", "sameAsBase", "required", "forbidden", "notAdded", "notRemoved", "pinnedLimitation"] as const;

  test.each(NORMAL_CASE_IDS)("%s: the real candidate decision satisfies expect + anchors", (id) => {
    const r = results.get(id);
    expect(r).toBeDefined();
    if (r && !r.casePass) {
      throw new Error(formatProvenanceCaseFailure(r));
    }
  });

  /**
   * T6 (review concern 4): NOT an ordinary per-case assertion. `test.skip`
   * so vitest's own summary never folds these three into the suite's
   * ordinary passed count -- each id still gets its own named row in the
   * test/vitest output, titled as a FINDING rather than left
   * indistinguishable from a genuine pass. The exact-field pin this test
   * used to assert directly now lives in the "reports all 39 dev cases"
   * test below (its "Exact-field pin (T6, review concern 4)" block), since
   * a skipped test's body never runs.
   *
   * Basis, verbatim from `stratum/evals/datasets/provenance/AUTHORING.md`'s
   * "## Interpretation choices" item 1: "A difference caused only by
   * completion in these cases is a fixture finding, not a candidate
   * failure."
   */
  test.skip.each(KNOWN_DIVERGENCE_IDS)("%s: FINDING (layer-(a), AUTHORING.md interpretation choice 1) -- known completion divergence, not a candidate failure", () => {
    // Not asserted here -- see this block's doc comment and the
    // "Exact-field pin (T6, review concern 4)" block in the "reports all
    // 39 dev cases" test below.
  });

  test("reports all 39 dev cases: per-family breakdown + predicted-vs-actual hit/miss table (this test IS the report -- it does not gate on every case passing)", () => {
    const all = [...results.values()];
    expect(all).toHaveLength(39);
    expect(new Set(all.map((r) => r.id)).size).toBe(39);

    // Ties this report to the SAME known-divergence set the per-case tests
    // pin above: the set of cases that actually fail expect/anchors must be
    // EXACTLY the three known, cited completion divergences -- no more (a
    // silent new regression) and no fewer (one of the three unexpectedly
    // starting to pass, which would mean this allowlist is stale and due
    // for an update).
    expect(all.filter((r) => !r.casePass).map((r) => r.id).sort()).toEqual([...KNOWN_DIVERGENCE_IDS].sort());

    // Exact-field pin (T6, review concern 4): moved here from the old
    // per-case `test.each(KNOWN_DIVERGENCE_IDS)` block above once that
    // block became a non-asserting `test.skip.each` (see its "FINDING
    // (layer-(a), ...)" titles and doc comment) -- a skipped test's body
    // never runs, so the assertions had to move somewhere that still runs
    // them. For each of the three known completion divergences, assert
    // EXACTLY which `expect.*`/`anchors` field(s) fail: a different field
    // failing, one of the three no longer failing, or a new, unexplained
    // failure anywhere else is caught here instead of silently
    // re-absorbed. Basis, verbatim from
    // `stratum/evals/datasets/provenance/AUTHORING.md`'s "## Interpretation
    // choices" item 1: "A difference caused only by completion in these
    // cases is a fixture finding, not a candidate failure."
    for (const id of KNOWN_DIVERGENCE_IDS) {
      const r = results.get(id);
      expect(r, `${id}: expected a result`).toBeDefined();
      if (!r) continue;
      const expectedFailingFields: ReadonlyArray<string> = KNOWN_COMPLETION_DIVERGENCES[id] ?? [];
      for (const field of EXPECT_SCORE_FIELDS) {
        const status = r.candidateScore[field].status;
        if (expectedFailingFields.includes(field)) {
          expect(status, `${id}: expected expect.${field} to fail (known completion divergence)`).toBe("fail");
        } else {
          expect(status, `${id}: expect.${field} unexpectedly failed -- this is a DIFFERENT divergence than the known one; investigate before updating the allowlist`).not.toBe("fail");
        }
      }
      expect(r.anchorScore.evidence.status, `${id}: anchors.evidence unexpectedly failed`).not.toBe("fail");
      expect(r.anchorScore.forbidden.status, `${id}: anchors.forbidden unexpectedly failed`).not.toBe("fail");
      expect(r.casePass, `${id}: expected casePass false (known completion divergence)`).toBe(false);
    }

    // Review concern 5 (T3): the assertion above pins WHICH case IDs fail,
    // but says nothing about the predictedBase/predictedCandidate hit and
    // miss COUNTS themselves -- a change to scorePredictedBase's or
    // scorePredictedCandidate's comparison that shifted those counts
    // without moving any case across the pass/fail line would pass every
    // assertion above silently. Pin the exact counts too, computed the same
    // way buildProvenanceDevReport does (filter results by verdict), so a
    // scoring-logic regression is caught here even when it changes no
    // case's casePass or failing-ID outcome.
    //
    // Confirmed empirically on this dev half with T1 and T2 both applied
    // (2026-09-26: `npx vitest run test/evals/provenance-fixture.test.ts
    // --reporter=verbose` inside stratum/, reading the same "##
    // predicted.base/predicted.candidate hits/misses" lines this test's own
    // `report` prints below) -- not assumed equal to cycle 1a's last
    // recorded tally, though they match it exactly: predicted.base 21 hits
    // / 2 misses / 16 n/a ("unknown"), predicted.candidate 36 hits / 3
    // misses. Red-first proof (a disposable, one-comparison-flipped stub of
    // each scoring function in turn, reverted immediately after) is
    // recorded in .workflow/proofs/provenance-cycle1a-fix-t3-scoring-guard-2026-09-26*.
    const baseHits = all.filter((r) => r.predictedBase.verdict === "hit").length;
    const baseMisses = all.filter((r) => r.predictedBase.verdict === "miss").length;
    const candHits = all.filter((r) => r.predictedCandidate.verdict === "hit").length;
    const candMisses = all.filter((r) => r.predictedCandidate.verdict === "miss").length;
    expect(baseHits, "predicted.base hits").toBe(21);
    expect(baseMisses, "predicted.base misses").toBe(2);
    expect(candHits, "predicted.candidate hits").toBe(36);
    expect(candMisses, "predicted.candidate misses").toBe(3);

    const report = buildProvenanceDevReport(all);
    // eslint-disable-next-line no-console -- this console.log IS the report; captured verbatim into the proof note's vitest log.
    console.log(report);

    expect(report).toContain("Provenance dev-half report -- 39 cases");
    expect(report).toContain("## Per-case predicted-vs-actual table");
    expect(report).toContain("## Per-family breakdown");
    expect(report).toContain("## predicted.base hits/misses");
    expect(report).toContain("## predicted.candidate hits/misses");
    expect(report).toContain("## Determinism");
    // Same counts, pinned in the report STRING buildProvenanceDevReport
    // actually produces (not only in the data the assertions above
    // recompute from `all`), so a regression inside the report's own
    // filter/format -- not only inside scorePredictedBase/scorePredictedCandidate --
    // is caught too.
    expect(report).toContain('hits=21 misses=2 n/a(predicted "unknown")=16');
    expect(report).toContain("hits=36 misses=3");
  });
});
