/**
 * Provenance fixture loader (REQ-15, specs/pruner/provenance-gated-selection.md).
 *
 * Loads a `pges-fixture.*.jsonl` file (dev or sealed half — the caller supplies
 * the path; this module has no opinion on which half it is and never hardcodes
 * either name), verifies the file's bytes against its committed `<file>.sha256`
 * sidecar (the `shasum -a 256 -c` format: a lowercase hex digest and a bare
 * file name — see evals/datasets/provenance/AUTHORING.md), then parses each
 * line as one JSON case record (see specs/pruner/provenance-fixture-brief.md
 * → "Record schema").
 *
 * A case is rejected (REQ-15's five bullets) when it:
 *  1. shares any 5-gram with a reference corpus (e.g. the golden Tier-C
 *     dataset or a Tier-B dataset) — a contamination check. Reference corpus
 *     files are read only inside the rule-1 pass, and no text from them (or
 *     the shared n-gram itself, which is by definition also their text) is
 *     ever included in a thrown error or returned value.
 *  2. names an exchange id in `expect.requiredExchangeIds`,
 *     `forbiddenExchangeIds`, `notAddedExchangeIds`, `notRemovedExchangeIds`,
 *     or `pinnedLimitation[].exchangeIds` with no matching `expect.derivation`
 *     entry.
 *  3. has a `reviewedLinks` entry whose named successor (`newerFactId`) was
 *     created before the fact it supersedes (`olderFactId`) — an inversion —
 *     unless the case is tagged `db_rejects`.
 *  4. has a fact `table` outside the six tables registered in `FACT_TABLES`
 *     (`src/memory/warm/tier2.ts`).
 *  5. has a turn (bound, unbound, or foreign) whose `ageSeconds` puts it
 *     beyond {@link PROVENANCE_WINDOW_MS} (7,200,000 ms / 2h), unless the
 *     case is tagged `long_window_not_production_reachable`.
 *
 * SHA-256 verification streams the file's bytes into a hash and compares
 * digests only — it never parses, prints, logs, or otherwise materializes
 * the file's decoded content. A mismatch's error carries only the file path
 * and the two hex digests.
 *
 * This module never reads `pges-fixture.sealed.jsonl` itself, or any other
 * path not supplied by its caller — every path this loader touches is a
 * parameter.
 */

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { FACT_TABLES } from "../../src/memory/warm/tier2";
import { DEFAULT_KADANEDIAL, type KadaneDialParams } from "../../src/pruner/kadanedial";
import { selectWithProvenance } from "../../src/pruner/provenance-select";
import type { ProvenanceDecision, ProvenanceFactRow, ProvenanceFactTable, ProvenanceHistoryTurn, ProvenanceLookupResult, ProvenanceReason, ProvenanceSnapshot } from "../../src/pruner/provenance-select";

/** REQ-15's hot window: 2 hours, in milliseconds. Not read from the record. */
export const PROVENANCE_WINDOW_MS = 7_200_000;

const LONG_WINDOW_TAG = "long_window_not_production_reachable";
const DB_REJECTS_TAG = "db_rejects";
const KNOWN_FACT_TABLES: ReadonlySet<string> = new Set(Object.values(FACT_TABLES));

/** One turn (user or assistant) inside an exchange, or an unbound/foreign turn. */
export interface ProvenanceTurn {
  role: string;
  text: string;
  ageSeconds: number;
  scopeId?: string;
}

/** One typed structured fact attached to an exchange. */
export interface ProvenanceFact {
  factId: string;
  /** Postgres table name. Rule 4 validates it against {@link FACT_TABLES}, so this stays a plain string rather than a strict union (a strict union would make an invalid-table test fixture fail to compile). */
  table: string;
  fields?: Record<string, unknown>;
  isSuppressed?: boolean;
  createdAtSeconds: number;
  auditStatus?: "CONFIRMED" | "UNVERIFIED" | "CONFLICT" | null;
  matchesQuery?: boolean;
}

/** One user+assistant exchange, keyed by a server-issued exchange id. */
export interface ProvenanceExchange {
  exchangeId: string;
  write?: "ok" | "failed";
  turns: ProvenanceTurn[];
  facts: ProvenanceFact[];
}

/** An exchange (or fact-only row) belonging to another org, conversation, or project. */
export interface ProvenanceForeignExchange {
  relation?: string;
  conversation?: unknown;
  exchangeId?: string;
  write?: "ok" | "failed";
  turns: ProvenanceTurn[];
  facts: ProvenanceFact[];
}

/** A reviewed supersession: `newerFactId` is declared a reviewed successor of `olderFactId`. */
export interface ProvenanceReviewedLink {
  newerFactId: string;
  olderFactId: string;
  reviewer?: string;
  evidence?: string;
  reviewedAtSeconds?: number;
}

/** A pinned known-limitation expectation, naming the exchanges it covers. */
export interface ProvenancePinnedLimitation {
  exchangeIds: string[];
  behavior?: "selected" | "sameAsBase";
  reason?: string;
}

/** The case's expected selector behavior, and the provenance `derivation` backing it. */
export interface ProvenanceExpect {
  fallback: string | null;
  sameAsBase: boolean;
  requiredExchangeIds: string[];
  forbiddenExchangeIds: string[];
  notAddedExchangeIds: string[];
  notRemovedExchangeIds: string[];
  pinnedLimitation: ProvenancePinnedLimitation[];
  /** Exchange id (or `"unbound:<i>"` / `"_case"`) → the provenance declaration behind it. */
  derivation: Record<string, string>;
}

/** One case record from a `pges-fixture.*.jsonl` file. */
export interface ProvenanceCase {
  id: string;
  family?: string;
  tags: string[];
  conversation?: unknown;
  windowMs?: number;
  nowSeconds?: number;
  query: string;
  exchanges: ProvenanceExchange[];
  unboundTurns: ProvenanceTurn[];
  reviewedLinks: ProvenanceReviewedLink[];
  foreign: ProvenanceForeignExchange[];
  lookupFault?: string | null;
  expect: ProvenanceExpect;
  predicted?: unknown;
  anchors?: unknown;
}

/** One of REQ-15's five reject rules, and the (content-free) reason it fired. */
export interface ProvenanceFixtureViolation {
  id: string;
  rule: "five_gram_overlap" | "derivation_free_expectation" | "reviewed_link_older_successor" | "invalid_fact_table" | "turn_beyond_window";
  detail: string;
}

/** The committed file's bytes do not match its `.sha256` sidecar. Carries only the path and the two digests — never file content. */
export class ShaMismatchError extends Error {
  constructor(
    readonly filePath: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`SHA-256 mismatch for ${filePath}: expected ${expected}, got ${actual}`);
    this.name = "ShaMismatchError";
  }
}

/** One or more cases in the file violated a REQ-15 reject rule. Carries structured, content-free violations only. */
export class ProvenanceFixtureRejectedError extends Error {
  constructor(
    readonly filePath: string,
    readonly violations: ProvenanceFixtureViolation[],
  ) {
    super(`${filePath}: ${violations.length} case(s) rejected — ${violations.map((v) => `${v.id}: ${v.rule} (${v.detail})`).join("; ")}`);
    this.name = "ProvenanceFixtureRejectedError";
  }
}

// ---------------------------------------------------------------------------
// Parsing (real from the start — this is plumbing, not one of REQ-15's rules)
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function asStringArray(v: unknown): string[] {
  return isStringArray(v) ? v : [];
}

function normalizeTurn(raw: unknown, context: string): ProvenanceTurn {
  const t = raw as Partial<ProvenanceTurn>;
  if (typeof t.role !== "string" || typeof t.text !== "string" || typeof t.ageSeconds !== "number") {
    throw new Error(`${context}: turn missing role/text/ageSeconds`);
  }
  return {
    role: t.role,
    text: t.text,
    ageSeconds: t.ageSeconds,
    ...(typeof t.scopeId === "string" ? { scopeId: t.scopeId } : {}),
  };
}

function normalizeFact(raw: unknown, context: string): ProvenanceFact {
  const f = raw as Partial<ProvenanceFact>;
  if (typeof f.factId !== "string" || typeof f.table !== "string" || typeof f.createdAtSeconds !== "number") {
    throw new Error(`${context}: fact missing factId/table/createdAtSeconds`);
  }
  return {
    factId: f.factId,
    table: f.table,
    createdAtSeconds: f.createdAtSeconds,
    ...(f.fields && typeof f.fields === "object" ? { fields: f.fields } : {}),
    ...(typeof f.isSuppressed === "boolean" ? { isSuppressed: f.isSuppressed } : {}),
    ...(f.auditStatus !== undefined ? { auditStatus: f.auditStatus } : {}),
    ...(typeof f.matchesQuery === "boolean" ? { matchesQuery: f.matchesQuery } : {}),
  };
}

function normalizeExchange(raw: unknown, context: string): ProvenanceExchange {
  const e = raw as Partial<ProvenanceExchange>;
  if (typeof e.exchangeId !== "string") throw new Error(`${context}: exchange missing exchangeId`);
  const turns = Array.isArray(e.turns) ? e.turns.map((t) => normalizeTurn(t, `${context} exchange ${e.exchangeId}`)) : [];
  const facts = Array.isArray(e.facts) ? e.facts.map((f) => normalizeFact(f, `${context} exchange ${e.exchangeId}`)) : [];
  return { exchangeId: e.exchangeId, turns, facts, ...(e.write ? { write: e.write } : {}) };
}

function normalizeForeignExchange(raw: unknown, context: string): ProvenanceForeignExchange {
  const e = raw as Partial<ProvenanceForeignExchange>;
  const turns = Array.isArray(e.turns) ? e.turns.map((t) => normalizeTurn(t, `${context} foreign exchange`)) : [];
  const facts = Array.isArray(e.facts) ? e.facts.map((f) => normalizeFact(f, `${context} foreign exchange`)) : [];
  return {
    turns,
    facts,
    ...(typeof e.relation === "string" ? { relation: e.relation } : {}),
    ...(e.conversation !== undefined ? { conversation: e.conversation } : {}),
    ...(typeof e.exchangeId === "string" ? { exchangeId: e.exchangeId } : {}),
    ...(e.write ? { write: e.write } : {}),
  };
}

function normalizeReviewedLink(raw: unknown, context: string): ProvenanceReviewedLink {
  const l = raw as Partial<ProvenanceReviewedLink>;
  if (typeof l.newerFactId !== "string" || typeof l.olderFactId !== "string") {
    throw new Error(`${context}: reviewedLinks entry missing newerFactId/olderFactId`);
  }
  return {
    newerFactId: l.newerFactId,
    olderFactId: l.olderFactId,
    ...(typeof l.reviewer === "string" ? { reviewer: l.reviewer } : {}),
    ...(typeof l.evidence === "string" ? { evidence: l.evidence } : {}),
    ...(typeof l.reviewedAtSeconds === "number" ? { reviewedAtSeconds: l.reviewedAtSeconds } : {}),
  };
}

function normalizePinnedLimitation(v: unknown): ProvenancePinnedLimitation[] {
  if (!Array.isArray(v)) return [];
  return v.map((entry) => {
    const e = entry as Partial<ProvenancePinnedLimitation>;
    return {
      exchangeIds: asStringArray(e.exchangeIds),
      ...(e.behavior ? { behavior: e.behavior } : {}),
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
    };
  });
}

function normalizeExpect(v: unknown): ProvenanceExpect {
  const e = (v ?? {}) as Partial<ProvenanceExpect>;
  const derivation = e.derivation && typeof e.derivation === "object" ? e.derivation : {};
  return {
    fallback: e.fallback ?? null,
    sameAsBase: e.sameAsBase ?? false,
    requiredExchangeIds: asStringArray(e.requiredExchangeIds),
    forbiddenExchangeIds: asStringArray(e.forbiddenExchangeIds),
    notAddedExchangeIds: asStringArray(e.notAddedExchangeIds),
    notRemovedExchangeIds: asStringArray(e.notRemovedExchangeIds),
    pinnedLimitation: normalizePinnedLimitation(e.pinnedLimitation),
    derivation,
  };
}

function normalizeCase(raw: unknown, lineNo: number): ProvenanceCase {
  const o = raw as Partial<ProvenanceCase>;
  if (typeof o.id !== "string" || typeof o.query !== "string" || !Array.isArray(o.exchanges)) {
    throw new Error(`provenance fixture line ${lineNo}: missing id/query/exchanges`);
  }
  const context = `provenance fixture line ${lineNo} (${o.id})`;
  return {
    id: o.id,
    query: o.query,
    tags: asStringArray(o.tags),
    exchanges: o.exchanges.map((e) => normalizeExchange(e, context)),
    unboundTurns: Array.isArray(o.unboundTurns) ? o.unboundTurns.map((t) => normalizeTurn(t, context)) : [],
    reviewedLinks: Array.isArray(o.reviewedLinks) ? o.reviewedLinks.map((l) => normalizeReviewedLink(l, context)) : [],
    foreign: Array.isArray(o.foreign) ? o.foreign.map((f) => normalizeForeignExchange(f, context)) : [],
    expect: normalizeExpect(o.expect),
    ...(typeof o.family === "string" ? { family: o.family } : {}),
    ...(o.conversation !== undefined ? { conversation: o.conversation } : {}),
    ...(typeof o.windowMs === "number" ? { windowMs: o.windowMs } : {}),
    ...(typeof o.nowSeconds === "number" ? { nowSeconds: o.nowSeconds } : {}),
    ...(o.lookupFault !== undefined ? { lookupFault: o.lookupFault } : {}),
    ...(o.predicted !== undefined ? { predicted: o.predicted } : {}),
    ...(o.anchors !== undefined ? { anchors: o.anchors } : {}),
  };
}

/** Parse one case per non-empty JSONL line. Throws with the line number only — never the line's content — on invalid JSON or a missing required field. */
function parseProvenanceCases(jsonl: string): ProvenanceCase[] {
  const cases: ProvenanceCase[] = [];
  let lineNo = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    lineNo++;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`provenance fixture line ${lineNo}: invalid JSON`);
    }
    cases.push(normalizeCase(parsed, lineNo));
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Rule 1: 5-gram contamination check against reference corpora
// ---------------------------------------------------------------------------

/** Recursively collect every string leaf of a JSON value, for the rule-1 contamination scan. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
}

const TOKEN_RE = /[a-z0-9]+/g;

/** Lowercase alphanumeric tokens of one string leaf. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

/** Every 5-gram (space-joined tokens) within one string leaf. 5-grams never span two leaves, so structural tokens (ids, tags, table names) in neighboring fields can't form a spurious cross-field match. */
function fiveGramsOf(text: string): Set<string> {
  const tokens = tokenize(text);
  const grams = new Set<string>();
  for (let i = 0; i + 5 <= tokens.length; i++) grams.add(tokens.slice(i, i + 5).join(" "));
  return grams;
}

/** Every 5-gram appearing in any string leaf of any JSON value in a JSONL file. Reads `path`'s content — used only by {@link checkFiveGramOverlap}, and the returned set is 5-gram keys only, never joined back into readable text. */
function fiveGramSetForJsonlFile(path: string): Set<string> {
  const raw = readFileSync(path, "utf8");
  const grams = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = line;
    }
    const leaves: string[] = [];
    collectStrings(parsed, leaves);
    for (const leaf of leaves) for (const g of fiveGramsOf(leaf)) grams.add(g);
  }
  return grams;
}

/**
 * Rule 1: reject a case sharing any 5-gram with a reference corpus.
 *
 * `referenceCorpusPaths` (e.g. the golden Tier-C dataset and a Tier-B
 * dataset) are read only in this function, and only to build in-memory
 * 5-gram sets — their text, and any shared 5-gram (by definition also their
 * text), never leaves this function; the violation names only the corpus
 * path.
 */
function checkFiveGramOverlap(cases: ProvenanceCase[], referenceCorpusPaths: string[], violations: ProvenanceFixtureViolation[]): void {
  const corpora = referenceCorpusPaths.map((path) => ({ path, grams: fiveGramSetForJsonlFile(path) }));
  if (corpora.length === 0) return;
  for (const c of cases) {
    const leaves: string[] = [];
    collectStrings(c, leaves);
    const caseGrams = new Set<string>();
    for (const leaf of leaves) for (const g of fiveGramsOf(leaf)) caseGrams.add(g);
    for (const { path, grams } of corpora) {
      let overlap = false;
      for (const g of caseGrams) {
        if (grams.has(g)) {
          overlap = true;
          break;
        }
      }
      if (overlap) violations.push({ id: c.id, rule: "five_gram_overlap", detail: `shares a 5-gram with ${path}` });
    }
  }
}

// ---------------------------------------------------------------------------
// Rules 2-5
// ---------------------------------------------------------------------------

/**
 * Rule 2: reject a case naming an exchange id in an `expect` list with no
 * matching `expect.derivation` entry.
 */
function checkDerivationCoverage(cases: ProvenanceCase[], violations: ProvenanceFixtureViolation[]): void {
  for (const c of cases) {
    const referenced = new Set<string>();
    for (const id of c.expect.requiredExchangeIds) referenced.add(id);
    for (const id of c.expect.forbiddenExchangeIds) referenced.add(id);
    for (const id of c.expect.notAddedExchangeIds) referenced.add(id);
    for (const id of c.expect.notRemovedExchangeIds) referenced.add(id);
    for (const pin of c.expect.pinnedLimitation) for (const id of pin.exchangeIds) referenced.add(id);
    const derivationKeys = new Set(Object.keys(c.expect.derivation));
    for (const id of referenced) {
      if (!derivationKeys.has(id)) violations.push({ id: c.id, rule: "derivation_free_expectation", detail: `exchange ${id} has no expect.derivation entry` });
    }
  }
}

/**
 * Rule 3: reject a case whose `reviewedLinks` entry names an older successor
 * (`newerFactId` created before `olderFactId`) unless tagged `db_rejects`.
 * An unresolvable `factId` is not one of REQ-15's five rules — left for T1B.
 */
function checkReviewedLinkOrder(cases: ProvenanceCase[], violations: ProvenanceFixtureViolation[]): void {
  for (const c of cases) {
    const createdAt = new Map<string, number>();
    for (const ex of c.exchanges) for (const f of ex.facts) createdAt.set(f.factId, f.createdAtSeconds);
    for (const fe of c.foreign) for (const f of fe.facts) createdAt.set(f.factId, f.createdAtSeconds);
    const isDbRejects = c.tags.includes(DB_REJECTS_TAG);
    for (const link of c.reviewedLinks) {
      const newerAt = createdAt.get(link.newerFactId);
      const olderAt = createdAt.get(link.olderFactId);
      if (newerAt === undefined || olderAt === undefined) continue; // unresolved factId: not one of REQ-15's five rules (see T1B)
      if (newerAt < olderAt && !isDbRejects) {
        violations.push({
          id: c.id,
          rule: "reviewed_link_older_successor",
          detail: `reviewedLinks names an older successor (${link.newerFactId} predates ${link.olderFactId}) without the db_rejects tag`,
        });
      }
    }
  }
}

/**
 * Rule 4: reject a case with a fact `table` outside {@link FACT_TABLES}.
 */
function checkKnownFactTables(cases: ProvenanceCase[], violations: ProvenanceFixtureViolation[]): void {
  for (const c of cases) {
    const allFacts = [...c.exchanges.flatMap((ex) => ex.facts), ...c.foreign.flatMap((fe) => fe.facts)];
    for (const f of allFacts) {
      if (!KNOWN_FACT_TABLES.has(f.table)) {
        violations.push({ id: c.id, rule: "invalid_fact_table", detail: `fact table '${f.table}' is not a known table` });
      }
    }
  }
}

/**
 * Rule 5: reject a case with a turn `ageSeconds` beyond
 * {@link PROVENANCE_WINDOW_MS}, unless tagged `long_window_not_production_reachable`.
 */
function checkWindowAge(cases: ProvenanceCase[], violations: ProvenanceFixtureViolation[]): void {
  for (const c of cases) {
    if (c.tags.includes(LONG_WINDOW_TAG)) continue;
    const allTurns = [...c.exchanges.flatMap((ex) => ex.turns), ...c.unboundTurns, ...c.foreign.flatMap((fe) => fe.turns)];
    for (const t of allTurns) {
      if (t.ageSeconds * 1000 > PROVENANCE_WINDOW_MS) {
        violations.push({ id: c.id, rule: "turn_beyond_window", detail: `turn ageSeconds=${t.ageSeconds} exceeds windowMs=${PROVENANCE_WINDOW_MS}` });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SHA-256 integrity gate
// ---------------------------------------------------------------------------

/** SHA-256 of a file's bytes, computed by streaming — never materializes the whole file as one buffer/string. */
function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Verify `filePath`'s bytes against its `<filePath>.sha256` sidecar
 * (`shasum -a 256 -c` semantics). Streams bytes into the hash only; never
 * parses, prints, or logs the file's content.
 *
 * Exported so a caller can run this check standalone, independent of
 * {@link loadProvenanceFixture}'s parse-and-check pipeline — e.g. verifying
 * `pges-fixture.sealed.jsonl`'s sidecar (REQ-15's "verify both files") without
 * loading or running the sealed half, which stays reserved for gate G1
 * (T1B; see `.workflow/proofs/provenance-fixture-checker-dev-run-2026-09-25.md`).
 *
 * @throws {ShaMismatchError} when the digests differ.
 */
export async function verifyCommittedSha256(filePath: string): Promise<void> {
  const sidecarPath = `${filePath}.sha256`;
  const sidecar = readFileSync(sidecarPath, "utf8");
  const match = /^([0-9a-fA-F]{64})/.exec(sidecar.trim());
  if (!match) throw new Error(`${sidecarPath}: no 64-character hex digest found`);
  const expected = match[1]!.toLowerCase();
  const actual = await sha256OfFile(filePath);
  if (actual !== expected) throw new ShaMismatchError(filePath, expected, actual);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Load and validate a `pges-fixture.*.jsonl` file.
 *
 * @param filePath Path to the JSONL file to load. The caller decides which
 *   half to load — this function is not sealed-file-specific.
 * @param referenceCorpusPaths Reference corpora checked for 5-gram overlap
 *   (rule 1), e.g. the golden Tier-C dataset and a Tier-B dataset. Pass `[]`
 *   to skip rule 1 entirely.
 * @returns Every parsed case, once none violates a REQ-15 reject rule.
 * @throws {ShaMismatchError} if `filePath`'s bytes don't match its `.sha256` sidecar.
 * @throws {ProvenanceFixtureRejectedError} if any case violates a reject rule.
 */
export async function loadProvenanceFixture(filePath: string, referenceCorpusPaths: string[]): Promise<ProvenanceCase[]> {
  await verifyCommittedSha256(filePath);
  const cases = parseProvenanceCases(readFileSync(filePath, "utf8"));

  const violations: ProvenanceFixtureViolation[] = [];
  checkFiveGramOverlap(cases, referenceCorpusPaths, violations);
  checkDerivationCoverage(cases, violations);
  checkReviewedLinkOrder(cases, violations);
  checkKnownFactTables(cases, violations);
  checkWindowAge(cases, violations);

  if (violations.length > 0) throw new ProvenanceFixtureRejectedError(filePath, violations);
  return cases;
}

// ---------------------------------------------------------------------------
// T7A -- ProvenanceCase -> provenance-select.ts's inputs
// (REQ-15 layer (a): "injected similarities and lookups")
//
// This section maps ONE already-loaded {@link ProvenanceCase} to the five
// arguments `selectWithProvenance` (src/pruner/provenance-select.ts) takes,
// plus one extra field T7B needs to score `"unbound:<i>"` expectations. It
// never calls `selectWithProvenance` itself -- that stays T7B's job (loading
// all 39 dev cases, running each through the real selector, and scoring the
// result against `expect`).
//
// ── Frozen scheme #1: the injected per-turn similarity (owner decision,
//    run.json acknowledgements, T7A) ────────────────────────────────────────
// The record schema (and the committed dev file, confirmed absent by grep)
// declares no per-turn similarity or embedding anywhere, so there is no given
// way to feed the unchanged base `prune()` a relevance signal. This is a
// genuine, spec-unspecified design choice -- fixed here, once, before any run,
// and never adjusted afterward based on results:
//
//   - It is a LEXICAL STAND-IN for the real MiniLM encoder (layer (b),
//     later work). It feeds ONLY the unchanged base `prune()` call inside
//     `selectWithProvenance` -- that function never sees these numbers on
//     its own terms (it only ever receives the embeddings), so the spec's
//     "no text heuristics" constraint (which binds `selectWithProvenance`
//     itself, REQ-6/7/9) does not apply to this harness-side stand-in.
//   - Query tokens ({@link lexicalQueryTokens}): lowercase, cut to 1,200
//     characters, split into runs of `[a-z0-9_./:-]`, keep tokens of >=3
//     characters that are not a stopword, keep the first 16 of THAT
//     filtered sequence, then dedupe to a set -- exactly
//     specs/pruner/provenance-fixture-brief.md's "Query match" rule.
//   - Turn tokens ({@link lexicalTurnTokens}): the same split/length/stopword
//     rule, with NO 1,200-character cut and NO 16-token cap.
//   - Similarity ({@link lexicalSimilarity}): cosine over the two binary
//     token sets, `|Q ∩ T| / sqrt(|Q| x |T|)`, and 0 when either set is
//     empty. It reads only the query string and one turn's own `text` --
//     never `matchesQuery` or any fact field.
//   - Encoding into `prune()`'s embeddings ({@link embeddingForSimilarity}):
//     `prune()` (src/pruner/pruner.ts) computes relevance as
//     `cosineSimilarity(queryEmbedding, turn.embedding)`
//     (src/pruner/encoder.ts), a plain dot product that ASSUMES both inputs
//     are already unit vectors -- it is the unchanged base algorithm and is
//     never touched here. To feed it an exact, pre-computed similarity `s`
//     without changing that function, every turn is a 2-D unit vector
//     `[s, sqrt(1 - s^2)]` against a FIXED query unit vector `[1, 0]`, so
//     `dot([1,0], [s, sqrt(1-s^2)]) === s` exactly (modulo float rounding).
//     This is the same 2-D convention test/pruner/provenance-select.test.ts's
//     own hand-built embeddings already use (`v(1, 0)`).
//
// ── Frozen scheme #2: `windowMs`/`ageSeconds` truncation ────────────────────
// Turns are NEVER filtered by `windowMs` or `ageSeconds` here. REQ-15's own
// rule 5 (`checkWindowAge`, above) already guarantees every turn in every
// `production_reachable`-only case is within {@link PROVENANCE_WINDOW_MS};
// the one committed case that is NOT (tagged
// `long_window_not_production_reachable`, per AUTHORING.md) lives in the
// sealed half, which this cycle never opens (gate G1). Adding
// age-based truncation here would be inventing selector behavior nowhere in
// this task's mapping; revisit only if/when the sealed half is opened and
// that specific case needs it.
//
// ── db_rejects + scope (reviewedObsolete / successorExchangeId) ────────────
// A `db_rejects`-tagged case disables EVERY `reviewedLinks` entry in that
// case (AUTHORING.md's own convention note: "the harness's injected layer
// must not honor it either") -- not only the one link the case is about.
// `reviewedObsolete` here implements the TAG rule ("honor a link unless
// db_rejects") AND the SCOPE the real RPC's NOT EXISTS predicate applies to
// the successor (supabase/migrations/20260924235700, 20260924235800:
// `successor.org_id = match_org AND successor.project_scope IS NOT DISTINCT
// FROM match_project_scope`, with NO `session_id` filter on the successor
// side). So a successor local to this case's own `exchanges`, or foreign
// with `relation: "other_conversation"` (same org+project, a different
// session -- AUTHORING.md interpretation choice #2: "the stale fact is
// dead"), marks the older fact obsolete; a foreign successor with
// `relation: "other_project"` or `"other_org"` does not, and neither does a
// successor whose factId resolves in neither map (fails closed, REQ-2's
// philosophy -- the committed dev fixture has no such case). This still
// does not implement {@link ProvenanceFactRow.reviewedObsolete}'s full
// documented predicate (later-created + unsuppressed + reviewer>=3 chars +
// evidence>=20 chars). AUTHORING.md's own second verification pass already
// confirmed every non-`db_rejects` link in the committed fixture satisfies
// that full predicate ("link validity: reviewer at least 3 characters,
// evidence at least 20 characters, and an older successor only in a case
// tagged db_rejects"), so on this fixture the two coincide; re-deriving the
// full predicate here would be redundant, not more correct.
// ---------------------------------------------------------------------------

const LEXICAL_STOPWORDS: ReadonlySet<string> = new Set(["the", "and", "for", "from", "with", "that", "this", "which", "what", "where", "when", "how", "are", "was", "were", "does", "have", "has", "its", "our", "their", "into", "about", "should"]);

/** The brief's exact character class for both query and turn tokenization. */
const LEXICAL_TOKEN_RE = /[a-z0-9_.\/:-]+/g;

const QUERY_MAX_CHARS = 1_200;
const QUERY_MAX_TOKENS = 16;

/** Split `text` into runs of the brief's character class, lowercased, keeping only tokens of >=3 chars that are not a stopword. No cap -- callers apply their own. */
function lexicalFilteredTokens(text: string): string[] {
  const matches = text.toLowerCase().match(LEXICAL_TOKEN_RE) ?? [];
  return matches.filter((t) => t.length >= 3 && !LEXICAL_STOPWORDS.has(t));
}

/** Query tokens (frozen scheme #1): lowercase, cut to 1,200 chars, the shared filter, then the first 16 of the FILTERED sequence, deduped to a set. Lowercases explicitly here (ahead of {@link lexicalFilteredTokens}'s own, idempotent lowercase) so the code follows the frozen text's exact clause order: "lowercase, cut ... split." */
export function lexicalQueryTokens(query: string): ReadonlySet<string> {
  const cut = query.toLowerCase().slice(0, QUERY_MAX_CHARS);
  return new Set(lexicalFilteredTokens(cut).slice(0, QUERY_MAX_TOKENS));
}

/** Turn tokens (frozen scheme #1): the same split/length/stopword rule, no char cut, no 16-token cap. */
export function lexicalTurnTokens(text: string): ReadonlySet<string> {
  return new Set(lexicalFilteredTokens(text));
}

/** The frozen layer-(a) similarity: cosine over binary token sets, 0 when either set is empty. Reads only the two token sets -- never `matchesQuery` or any fact field. */
export function lexicalSimilarity(queryTokens: ReadonlySet<string>, turnTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0 || turnTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of queryTokens) if (turnTokens.has(t)) overlap++;
  return overlap / Math.sqrt(queryTokens.size * turnTokens.size);
}

/** The fixed query unit vector `[1, 0]` every case's `queryEmbedding` uses (frozen scheme #1). */
const QUERY_UNIT_EMBEDDING = Float32Array.from([1, 0]);

/** Encode a similarity in [0,1] as a 2-D unit vector so `cosineSimilarity(QUERY_UNIT_EMBEDDING, this) === similarity` exactly (frozen scheme #1). Clamped defensively against float drift just outside [0,1]. */
function embeddingForSimilarity(similarity: number): Float32Array {
  const s = Math.min(1, Math.max(0, similarity));
  return Float32Array.from([s, Math.sqrt(Math.max(0, 1 - s * s))]);
}

/** `md5(lower(btrim(field)))`'s hash half. Postgres `btrim` (no explicit chars) trims plain spaces only, unlike JS's whitespace-eating `.trim()` -- {@link btrimSpaces} matches the SQL behavior this harness stands in for. */
function md5Hex(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/** SQL `btrim(text)`: strips leading/trailing ASCII spaces only (not tabs/newlines, unlike `.trim()`). */
function btrimSpaces(s: string): string {
  return s.replace(/^ +| +$/g, "");
}

/** The identity-key field name(s) per table (spec Definitions + the brief). `function_changes` hashes BOTH fields independently; `todos` has none. */
const FACT_KEY_FIELDS: Record<ProvenanceFactTable, readonly string[]> = {
  function_changes: ["old_name", "new_name"],
  tech_decisions: ["domain"],
  policy_updates: ["policy_name"],
  variable_changes: ["var_name"],
  operational_references: ["subject"],
  todos: [],
};

const KNOWN_PROVENANCE_FACT_TABLES: ReadonlySet<string> = new Set(Object.keys(FACT_KEY_FIELDS));

/** Validate + narrow a fixture's free-form `table` string to {@link ProvenanceFactTable}. T1's rule 4 (`checkKnownFactTables`) already rejects an unknown table for any REAL loaded case; this only guards a hand-built test object that bypasses the loader. */
function asProvenanceFactTable(table: string, context: string): ProvenanceFactTable {
  if (!KNOWN_PROVENANCE_FACT_TABLES.has(table)) {
    throw new Error(`${context}: unrecognized fact table '${table}'`);
  }
  return table as ProvenanceFactTable;
}

/** `keyHashes` (REQ-6): one `md5(lower(btrim(field)))` per identity-key field of `table` that is present as a non-empty string. Always `[]` for `todos`. */
function keyHashesFor(table: ProvenanceFactTable, fields: Record<string, unknown> | undefined): string[] {
  const hashes: string[] = [];
  for (const fieldName of FACT_KEY_FIELDS[table]) {
    const raw = fields?.[fieldName];
    if (typeof raw !== "string") continue;
    const normalized = btrimSpaces(raw).toLowerCase();
    if (normalized.length === 0) continue;
    hashes.push(md5Hex(normalized));
  }
  return hashes;
}

/** Everything selectWithProvenance's five arguments need, from one translated case, plus `unboundHistoryIndices` for T7B's `"unbound:<i>"` scoring (sorting can move an unbound turn away from its original `unboundTurns` array index, and only this translator still knows the mapping). */
export interface TranslatedProvenanceCase {
  queryEmbedding: Float32Array;
  history: ProvenanceHistoryTurn[];
  params: KadaneDialParams;
  queryScopeId?: string;
  snapshot: ProvenanceSnapshot;
  /** `history[unboundHistoryIndices[i]]` is `unboundTurns[i]`, after the oldest-first sort. */
  unboundHistoryIndices: number[];
  /**
   * The source {@link ProvenanceTurn} behind `history[i]`, same order, same
   * length -- T7B's own addition, read only for `anchors` scoring (the turn
   * `text` a selected index carries) and for human-readable case-failure
   * summaries. Never consulted by the translation above this point, and
   * never fed to `selectWithProvenance` (which only ever sees `history`'s
   * embeddings/timestamps/exchangeId).
   */
  historyTurns: ProvenanceTurn[];
}

/** One turn plus enough origin info to place it in `history` and (for an unbound turn) recover its original `unboundTurns` index afterward. */
interface HistoryEntry {
  turn: ProvenanceTurn;
  exchangeId?: string;
  unboundIndex?: number;
  timestampSeconds: number;
}

/**
 * `reviewedObsolete`/`successorExchangeId` for one fact (see this section's
 * header note on why this implements the tag + scope rules, not the full
 * predicate).
 *
 * @param reviewedOlderMap - `olderFactId` -> the first {@link ProvenanceReviewedLink} naming it (already empty for a `db_rejects` case).
 * @param localFactExchange - `factId` -> the LOCAL (this case's own `exchanges`) exchange that holds it. A successor resolving here yields `reviewedObsolete: true` WITH `successorExchangeId` set (REQ-12: same-session only).
 * @param foreignFactRelation - `factId` -> the `relation` of the `c.foreign` entry that holds it. A successor resolving only here yields `reviewedObsolete: true` with NO `successorExchangeId` when `relation === "other_conversation"` (same org+project per the real RPC's NOT EXISTS predicate -- no `session_id` filter on the successor side); `reviewedObsolete: false` for `"other_project"`/`"other_org"`, and `reviewedObsolete: false` when the successor resolves in neither map (untagged/unresolved -- fails closed, REQ-2's philosophy).
 */
function reviewedObsoleteFields(factId: string, reviewedOlderMap: ReadonlyMap<string, ProvenanceReviewedLink>, localFactExchange: ReadonlyMap<string, string>, foreignFactRelation: ReadonlyMap<string, string>): Pick<ProvenanceFactRow, "reviewedObsolete" | "successorExchangeId"> {
  const link = reviewedOlderMap.get(factId);
  if (link === undefined) return { reviewedObsolete: false };
  const successorExchangeId = localFactExchange.get(link.newerFactId);
  if (successorExchangeId !== undefined) return { reviewedObsolete: true, successorExchangeId };
  return { reviewedObsolete: foreignFactRelation.get(link.newerFactId) === "other_conversation" };
}

/** One local exchange's fact -> one {@link ProvenanceFactRow}. */
function buildFactRow(fact: ProvenanceFact, exchangeId: string, reviewedOlderMap: ReadonlyMap<string, ProvenanceReviewedLink>, localFactExchange: ReadonlyMap<string, string>, foreignFactRelation: ReadonlyMap<string, string>, context: string): ProvenanceFactRow {
  const table = asProvenanceFactTable(fact.table, context);
  return {
    exchangeId,
    factTable: table,
    factId: fact.factId,
    keyHashes: keyHashesFor(table, fact.fields),
    active: fact.isSuppressed !== true,
    auditStatus: fact.auditStatus ?? null,
    queryMatch: fact.matchesQuery === true,
    ...reviewedObsoleteFields(fact.factId, reviewedOlderMap, localFactExchange, foreignFactRelation),
  };
}

/**
 * `lookupFault: "malformed"` (family `malformed_rows`). AUTHORING.md: the
 * case's OWN data is valid ("keep valid data"); the harness itself injects
 * the fault, since the fixture format has no field for "which row, corrupted
 * how". Deterministic choice: corrupt the first translated row's `active`
 * field to a non-boolean runtime value -- the exact technique
 * test/pruner/provenance-select.test.ts's own malformed-row test already
 * uses for "an otherwise malformed row", kept consistent here.
 */
function injectMalformedRow(rows: readonly ProvenanceFactRow[]): ProvenanceFactRow[] {
  if (rows.length === 0) {
    // Defensive only: AUTHORING.md's "malformed_rows keeps valid data"
    // convention means every real case reaching here has >=1 row.
    return [{ exchangeId: "", factTable: "tech_decisions", factId: "malformed-synthetic", keyHashes: [], active: true, reviewedObsolete: false, auditStatus: null, queryMatch: false } as unknown as ProvenanceFactRow];
  }
  const [first, ...rest] = rows;
  return [{ ...first, active: "yes" } as unknown as ProvenanceFactRow, ...rest];
}

/**
 * `lookupFault: "duplicate_fact_id"`: append a second copy of one real row so
 * its `factId` repeats. WHICH row is duplicated is immaterial to the case's
 * own expectation: `hasInvalidRow` (provenance-select.ts) rejects on ANY
 * repeated `factId`, so the outcome (LOOKUP_INVALID, `sameAsBase`) is
 * identical regardless of which fact was chosen. AUTHORING.md names the
 * intended fact only in prose (the case's own `_case` derivation text),
 * which this pure translator does not parse.
 */
function injectDuplicateRow(rows: readonly ProvenanceFactRow[]): ProvenanceFactRow[] {
  if (rows.length === 0) return [...rows]; // defensive only; see injectMalformedRow
  return [...rows, rows[0]!];
}

/**
 * `lookupFault: "foreign_row"`. AUTHORING.md: "the injected lookup returns
 * the facts in `foreign`". Each foreign fact becomes a row carrying its OWN
 * (out-of-window) `exchangeId` -- exactly what makes `hasInvalidRow` reject
 * it as foreign; it is never mistaken for an in-window row.
 */
function foreignFaultRows(foreign: readonly ProvenanceForeignExchange[]): ProvenanceFactRow[] {
  const rows: ProvenanceFactRow[] = [];
  for (const entry of foreign) {
    if (typeof entry.exchangeId !== "string" || entry.exchangeId.length === 0) continue;
    for (const fact of entry.facts) {
      const table = asProvenanceFactTable(fact.table, "foreign fact");
      rows.push({
        exchangeId: entry.exchangeId,
        factTable: table,
        factId: fact.factId,
        keyHashes: keyHashesFor(table, fact.fields),
        active: fact.isSuppressed !== true,
        reviewedObsolete: false,
        auditStatus: fact.auditStatus ?? null,
        queryMatch: fact.matchesQuery === true,
      });
    }
  }
  return rows;
}

/**
 * Map one loaded {@link ProvenanceCase} to `selectWithProvenance`'s five
 * inputs (see this section's header for the frozen similarity + windowMs
 * notes, and db_rejects handling).
 *
 * @throws {Error} if `c.nowSeconds` is absent (every real fixture case sets
 *   it; this never falls back to the wall clock) or a fact names a table
 *   outside the six known ones (T1's rule 4 already guarantees this can't
 *   happen for a REAL loaded case).
 */
export function translateProvenanceCase(c: ProvenanceCase): TranslatedProvenanceCase {
  if (typeof c.nowSeconds !== "number") {
    throw new Error(`case ${c.id}: nowSeconds is required for translation (every fixture case sets it; never defaulted to the wall clock)`);
  }
  const nowSeconds = c.nowSeconds;

  const conversation = c.conversation as { projectScopeId?: string | null } | undefined;
  const queryScopeId = conversation && typeof conversation.projectScopeId === "string" ? conversation.projectScopeId : undefined;

  const queryTokens = lexicalQueryTokens(c.query);

  // ---- history: local-exchange turns + unbound turns, oldest-first -------
  // Foreign turns are never included (this section's own header: "foreign
  // translate to omitted-from-the-snapshot" -- extended here to history too,
  // since a foreign exchange belongs to a different conversation's turn
  // sequence entirely, regardless of whether its `scopeId` happens to match).
  const entries: HistoryEntry[] = [];
  for (const exchange of c.exchanges) {
    for (const turn of exchange.turns) entries.push({ turn, exchangeId: exchange.exchangeId, timestampSeconds: nowSeconds - turn.ageSeconds });
  }
  c.unboundTurns.forEach((turn, unboundIndex) => entries.push({ turn, unboundIndex, timestampSeconds: nowSeconds - turn.ageSeconds }));

  // Stable sort (native, ES2019+): entries with equal timestamps keep their
  // original relative order, so this is deterministic even on a hand-built
  // test case with tied ages (real fixture ages are always distinct per
  // AUTHORING.md, so ties are a defensive-only concern).
  entries.sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const history: ProvenanceHistoryTurn[] = [];
  const historyTurns: ProvenanceTurn[] = [];
  const unboundHistoryIndices: number[] = new Array(c.unboundTurns.length);
  entries.forEach((entry, historyIndex) => {
    history.push({
      embedding: embeddingForSimilarity(lexicalSimilarity(queryTokens, lexicalTurnTokens(entry.turn.text))),
      timestampSeconds: entry.timestampSeconds,
      ...(entry.turn.scopeId !== undefined ? { scopeId: entry.turn.scopeId } : {}),
      ...(entry.exchangeId !== undefined ? { exchangeId: entry.exchangeId } : {}),
    });
    historyTurns.push(entry.turn);
    if (entry.unboundIndex !== undefined) unboundHistoryIndices[entry.unboundIndex] = historyIndex;
  });

  // ---- snapshot: write -> failedExchangeIds; facts -> provenance rows ----
  const failedExchangeIds = new Set(c.exchanges.filter((e) => e.write === "failed").map((e) => e.exchangeId));

  const dbRejects = c.tags.includes(DB_REJECTS_TAG);
  const reviewedOlderMap = new Map<string, ProvenanceReviewedLink>();
  if (!dbRejects) {
    for (const link of c.reviewedLinks) {
      if (!reviewedOlderMap.has(link.olderFactId)) reviewedOlderMap.set(link.olderFactId, link); // first link wins (AUTHORING.md documents no case relying on a second)
    }
  }

  const localFactExchange = new Map<string, string>();
  for (const exchange of c.exchanges) for (const fact of exchange.facts) localFactExchange.set(fact.factId, exchange.exchangeId);

  // factId -> the relation of the `foreign` entry that holds it (D2 fix: a
  // reviewed successor's scope, not just its presence, gates reviewedObsolete
  // -- see reviewedObsoleteFields's own header note above).
  const foreignFactRelation = new Map<string, string>();
  for (const fe of c.foreign) for (const fact of fe.facts) if (typeof fe.relation === "string") foreignFactRelation.set(fact.factId, fe.relation);

  const rows: ProvenanceFactRow[] = [];
  for (const exchange of c.exchanges) {
    for (const fact of exchange.facts) rows.push(buildFactRow(fact, exchange.exchangeId, reviewedOlderMap, localFactExchange, foreignFactRelation, `case ${c.id}`));
  }

  let lookup: ProvenanceLookupResult;
  const fault = c.lookupFault ?? null;
  switch (fault) {
    case null:
      lookup = { kind: "ok", rows };
      break;
    case "reject":
      lookup = { kind: "error", cause: "reject" };
      break;
    case "timeout":
      lookup = { kind: "error", cause: "timeout" };
      break;
    case "malformed":
      lookup = { kind: "ok", rows: injectMalformedRow(rows) };
      break;
    case "duplicate_fact_id":
      lookup = { kind: "ok", rows: injectDuplicateRow(rows) };
      break;
    case "foreign_row":
      lookup = { kind: "ok", rows: [...rows, ...foreignFaultRows(c.foreign)] };
      break;
    default:
      throw new Error(`case ${c.id}: unrecognized lookupFault '${String(fault)}'`);
  }

  return {
    queryEmbedding: QUERY_UNIT_EMBEDDING,
    history,
    params: { ...DEFAULT_KADANEDIAL, nowSeconds },
    ...(queryScopeId !== undefined ? { queryScopeId } : {}),
    snapshot: { lookup, failedExchangeIds },
    unboundHistoryIndices,
    historyTurns,
  };
}

// ---------------------------------------------------------------------------
// T7B -- score one translated dev-half case's REAL selectWithProvenance
// output against its own `expect`/`predicted`/`anchors` blocks.
//
// This section never edits a case, never invents an expectation, and never
// re-derives REQ-15's reject rules (T1's job) or the translation itself
// (T7A's job, above) -- it only SCORES what T7A's translator + the real pure
// function (`selectWithProvenance`) produce, per AUTHORING.md's conventions
// and the run.json acknowledgements this cycle recorded for T7:
//
//   - `notRemoved` also encodes completion: "if the base kept any turn, every
//     turn of that exchange stays" (AUTHORING.md). `notAdded`/`notRemoved`
//     are therefore scored as IMPLICATIONS relative to THIS RUN's own base
//     decision (`provenance.baseSelectedIndices`), never relative to
//     `predicted.base` or any other guess -- that keeps them well-defined and
//     correctly scoreable under T7A's frozen lexical stand-in even where the
//     stand-in's own base selection differs from what a real encoder would
//     pick. Scored this way, `notAdded` is a tautology when the selection
//     being checked IS the base (selected === baseSelected); `notRemoved` is
//     NOT -- a base decision that only partially selected an exchange still
//     fails `notRemoved` against itself (see `pg-partner_completion-3`,
//     `predicted.base: "fail"`, below).
//   - `sameAsBase: false` asserts nothing (AUTHORING.md #9) -- scored
//     not-applicable, never "must differ".
//   - `"unbound:<i>"` in a list means `unboundTurns[i]` (AUTHORING.md),
//     resolved through T7A's own `unboundHistoryIndices` -- never re-sorted
//     here.
//   - `pinnedLimitation` behavior `"selected"` is `required`'s own semantics
//     (every turn of every listed id selected); behavior `"sameAsBase"` is
//     per-id equality between this run's candidate and its own base -- both
//     occur in the committed dev half (`split_key_leak`, `unreviewed_same_key`,
//     `older_authoritative_newer_draft`, `noise_only_leak`).
//   - `fallback` is compared by exact equality in BOTH directions: a
//     non-null `expect.fallback` that did not fire, or a guard firing when
//     `expect.fallback` is null, is a real defect either way -- never a
//     layer-(a) artifact.
//   - `predicted.base`/`predicted.candidate` hits/misses are reported
//     SEPARATELY from `expect.*`/`anchors` pass/fail (owner decision,
//     run.json acknowledgements, 2026-09-26, "Reporting rule for T7B"): a
//     `predicted.base` miss is filed under the layer-(a) lexical stand-in
//     label and is NEVER a fixture finding by itself (the author predicted
//     against a real encoder); a `predicted.candidate` miss is a genuine
//     finding. Neither is ever a reason to edit the fixture or this scheme.
// ---------------------------------------------------------------------------

export type ExpectFieldStatus = "pass" | "fail" | "n/a";

/** One `expect.*` (or `anchors`) field's verdict. `detail` is set only on `"fail"`. */
export interface ExpectFieldResult {
  status: ExpectFieldStatus;
  detail?: string;
}

/** Every `expect.*` field this task's reporting rule names as pass/fail (owner decision), plus the case's overall verdict. */
export interface ExpectScore {
  fallback: ExpectFieldResult;
  sameAsBase: ExpectFieldResult;
  required: ExpectFieldResult;
  forbidden: ExpectFieldResult;
  notAdded: ExpectFieldResult;
  notRemoved: ExpectFieldResult;
  pinnedLimitation: ExpectFieldResult;
  /** `true` iff every field above is `"pass"` or `"n/a"` -- never `"fail"`. */
  overallPass: boolean;
}

/** `anchors.evidence`/`anchors.forbidden`, scored against the CANDIDATE's own selected turns' text. */
export interface AnchorScore {
  evidence: ExpectFieldResult;
  forbidden: ExpectFieldResult;
}

/**
 * `id -> history[] indices` for every id an `expect` list can name: a bound
 * exchangeId resolves to every one of its turns' history indices; an
 * `"unbound:<i>"` token resolves to `unboundTurns[i]`'s single history index
 * (via T7A's own `unboundHistoryIndices`). `"_case"` (a derivation-only key,
 * never a real list member -- AUTHORING.md) is never a key here.
 */
function buildIdIndexMap(t: TranslatedProvenanceCase): ReadonlyMap<string, number[]> {
  const map = new Map<string, number[]>();
  t.history.forEach((turn, i) => {
    if (turn.exchangeId === undefined) return;
    const bucket = map.get(turn.exchangeId);
    if (bucket) bucket.push(i);
    else map.set(turn.exchangeId, [i]);
  });
  t.unboundHistoryIndices.forEach((historyIndex, unboundIndex) => {
    map.set(`unbound:${unboundIndex}`, [historyIndex]);
  });
  return map;
}

/**
 * Whether ANY / ALL of `indices` are members of `selected`. An id with no
 * resolved indices (should never happen for a real fixture case -- T1's rule
 * 2 already guarantees every listed id has a `derivation` entry, and every
 * such id resolves here) reports `all: true` defensively, so a stray
 * unresolved id can never manufacture a spurious `required`/`notRemoved`
 * failure on its own.
 */
function selectionState(indices: readonly number[], selected: ReadonlySet<number>): { any: boolean; all: boolean } {
  if (indices.length === 0) return { any: false, all: true };
  let any = false;
  let all = true;
  for (const i of indices) {
    if (selected.has(i)) any = true;
    else all = false;
  }
  return { any, all };
}

/** Shared per-id-list scorer: `ids` is `"n/a"` when empty, else `"pass"` iff `predicate` holds for every id, else `"fail"` naming every id that didn't. */
function scoreIdList(
  ids: readonly string[],
  idIndexMap: ReadonlyMap<string, number[]>,
  selected: ReadonlySet<number>,
  baseSelected: ReadonlySet<number>,
  predicate: (state: { any: boolean; all: boolean }, baseState: { any: boolean; all: boolean }) => boolean,
  failureLabel: string,
): ExpectFieldResult {
  if (ids.length === 0) return { status: "n/a" };
  const misses: string[] = [];
  for (const id of ids) {
    const indices = idIndexMap.get(id) ?? [];
    const state = selectionState(indices, selected);
    const baseState = selectionState(indices, baseSelected);
    if (!predicate(state, baseState)) misses.push(id);
  }
  return misses.length === 0 ? { status: "pass" } : { status: "fail", detail: `${failureLabel}: ${misses.join(", ")}` };
}

/** `requiredExchangeIds`: every turn of every listed id must be selected. */
function scoreRequired(ids: readonly string[], idIndexMap: ReadonlyMap<string, number[]>, selected: ReadonlySet<number>, baseSelected: ReadonlySet<number>): ExpectFieldResult {
  return scoreIdList(ids, idIndexMap, selected, baseSelected, (state) => state.all, "not fully selected");
}

/** `forbiddenExchangeIds`: no turn of any listed id may be selected. */
function scoreForbidden(ids: readonly string[], idIndexMap: ReadonlyMap<string, number[]>, selected: ReadonlySet<number>, baseSelected: ReadonlySet<number>): ExpectFieldResult {
  return scoreIdList(ids, idIndexMap, selected, baseSelected, (state) => !state.any, "selected despite being forbidden");
}

/** `notAddedExchangeIds`: "selected only if the base selected it" -- `selectedAny ⟹ baseAny`, checked against THIS RUN's own base (never `predicted.base`). */
function scoreNotAdded(ids: readonly string[], idIndexMap: ReadonlyMap<string, number[]>, selected: ReadonlySet<number>, baseSelected: ReadonlySet<number>): ExpectFieldResult {
  return scoreIdList(ids, idIndexMap, selected, baseSelected, (state, baseState) => !state.any || baseState.any, "added although the base did not select it");
}

/**
 * `notRemovedExchangeIds`: "if the base selected any of its turns, all of its
 * turns stay" -- `baseAny ⟹ selectedAll`. NOT a tautology when scored
 * base-vs-itself (`selected === baseSelected`): a base decision that only
 * PARTIALLY selected an exchange still fails this field against itself.
 */
function scoreNotRemoved(ids: readonly string[], idIndexMap: ReadonlyMap<string, number[]>, selected: ReadonlySet<number>, baseSelected: ReadonlySet<number>): ExpectFieldResult {
  return scoreIdList(ids, idIndexMap, selected, baseSelected, (state, baseState) => !baseState.any || state.all, "not fully retained although the base selected part of it");
}

/**
 * `pinnedLimitation[]`: behavior `"selected"` is `required`'s own per-id rule
 * (every turn of the listed id selected); behavior `"sameAsBase"` is
 * per-TURN equality between this run's selection and its own base, over
 * exactly the listed id's indices (strictly finer than the case-level
 * `sameAsBase` boolean, and meaningful even when that boolean is `false` --
 * see `pg-noise_only_leak-1`, whose case-level `sameAsBase` is `false` but
 * whose noise exchange is pinned `sameAsBase` on its own). An entry with no
 * declared `behavior` is a fixture-shape defect (every committed entry sets
 * one) and is reported as a failure rather than silently skipped.
 */
function scorePinnedLimitation(entries: readonly ProvenancePinnedLimitation[], idIndexMap: ReadonlyMap<string, number[]>, selected: ReadonlySet<number>, baseSelected: ReadonlySet<number>): ExpectFieldResult {
  if (entries.length === 0) return { status: "n/a" };
  const misses: string[] = [];
  for (const entry of entries) {
    for (const id of entry.exchangeIds) {
      const indices = idIndexMap.get(id) ?? [];
      if (entry.behavior === "selected") {
        if (!selectionState(indices, selected).all) misses.push(`${id} (selected)`);
      } else if (entry.behavior === "sameAsBase") {
        const differs = indices.some((i) => selected.has(i) !== baseSelected.has(i));
        if (differs) misses.push(`${id} (sameAsBase)`);
      } else {
        misses.push(`${id} (pinnedLimitation entry with no declared behavior)`);
      }
    }
  }
  return misses.length === 0 ? { status: "pass" } : { status: "fail", detail: misses.join(", ") };
}

/** Case-level `sameAsBase`. `false` asserts nothing (AUTHORING.md #9) -- scored `"n/a"`, never "must differ". */
function scoreSameAsBase(expectSameAsBase: boolean, selected: ReadonlySet<number>, baseSelected: ReadonlySet<number>): ExpectFieldResult {
  if (!expectSameAsBase) return { status: "n/a" };
  const equal = selected.size === baseSelected.size && [...selected].every((i) => baseSelected.has(i));
  return equal ? { status: "pass" } : { status: "fail", detail: "selectedIndices differ from baseSelectedIndices" };
}

/**
 * `fallback`. Exact equality both ways: a guard that fires when
 * `expect.fallback` is `null`, or fails to fire when it names a reason, is a
 * real defect either way -- never scored as a layer-(a) artifact.
 * `applicable: false` (used for base-alone scoring; a raw base decision has
 * no guard/reason of its own) reports `"n/a"`.
 */
function scoreFallback(expectFallback: string | null, actualReason: ProvenanceReason | null, applicable: boolean): ExpectFieldResult {
  if (!applicable) return { status: "n/a" };
  return actualReason === expectFallback ? { status: "pass" } : { status: "fail", detail: `expected reason ${JSON.stringify(expectFallback)}, got ${JSON.stringify(actualReason)}` };
}

/**
 * Score one selection (the candidate, or a base-alone run) against one
 * case's `expect`. `reason`/`fallbackApplicable` are meaningful only for the
 * candidate call -- a base-alone decision has no guard of its own, so the
 * caller passes `fallbackApplicable: false` (and `reason: null`) for that run.
 */
function scoreExpect(expect: ProvenanceExpect, idIndexMap: ReadonlyMap<string, number[]>, selected: ReadonlySet<number>, baseSelected: ReadonlySet<number>, reason: ProvenanceReason | null, fallbackApplicable: boolean): ExpectScore {
  const fallback = scoreFallback(expect.fallback, reason, fallbackApplicable);
  const sameAsBase = scoreSameAsBase(expect.sameAsBase, selected, baseSelected);
  const required = scoreRequired(expect.requiredExchangeIds, idIndexMap, selected, baseSelected);
  const forbidden = scoreForbidden(expect.forbiddenExchangeIds, idIndexMap, selected, baseSelected);
  const notAdded = scoreNotAdded(expect.notAddedExchangeIds, idIndexMap, selected, baseSelected);
  const notRemoved = scoreNotRemoved(expect.notRemovedExchangeIds, idIndexMap, selected, baseSelected);
  const pinnedLimitation = scorePinnedLimitation(expect.pinnedLimitation, idIndexMap, selected, baseSelected);
  const overallPass = [fallback, sameAsBase, required, forbidden, notAdded, notRemoved, pinnedLimitation].every((f) => f.status !== "fail");
  return { fallback, sameAsBase, required, forbidden, notAdded, notRemoved, pinnedLimitation, overallPass };
}

/** `anchors`: a content-level, id-independent check redundant with `required`/`forbidden` -- `evidence` substrings must appear somewhere in the CANDIDATE's own selected turns' text (newline-joined, oldest-first); `forbidden` substrings must appear nowhere in it. */
function scoreAnchors(anchors: unknown, historyTurns: readonly ProvenanceTurn[], selected: ReadonlySet<number>): AnchorScore {
  const a = (anchors ?? {}) as { evidence?: unknown; forbidden?: unknown };
  const evidence = isStringArray(a.evidence) ? a.evidence : [];
  const forbidden = isStringArray(a.forbidden) ? a.forbidden : [];
  const selectedText = [...selected]
    .sort((x, y) => x - y)
    .map((i) => historyTurns[i]?.text ?? "")
    .join("\n");
  const missingEvidence = evidence.filter((s) => !selectedText.includes(s));
  const leakedForbidden = forbidden.filter((s) => selectedText.includes(s));
  return {
    evidence: evidence.length === 0 ? { status: "n/a" } : missingEvidence.length === 0 ? { status: "pass" } : { status: "fail", detail: `missing from the selection's text: ${JSON.stringify(missingEvidence)}` },
    forbidden: forbidden.length === 0 ? { status: "n/a" } : leakedForbidden.length === 0 ? { status: "pass" } : { status: "fail", detail: `present in the selection's text despite being forbidden: ${JSON.stringify(leakedForbidden)}` },
  };
}

function sameIndexArray(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Two decisions from the SAME inputs must be bit-identical -- `equal_similarity`'s
 * own (and only) expectation ("the only expectation is that repeated runs
 * return an identical decision", `_case`, AUTHORING.md). Cheap enough to
 * check for every case, not only `equal_similarity`.
 */
function decisionsMatch(a: ProvenanceDecision, b: ProvenanceDecision): boolean {
  return sameIndexArray(a.selectedIndices, b.selectedIndices) && sameIndexArray(a.prunedIndices, b.prunedIndices) && a.provenance.reason === b.provenance.reason;
}

/**
 * Human-readable per-exchange (+ per-unbound-turn) selection summary:
 * `<exchangeId>: none|all|partial(k/n)` for a bound exchange, `unbound:<i>:
 * selected|not selected` for an unbound turn. Used to report "the base's
 * selection for that case alongside" every `expect` failure and every
 * `predicted.base` miss (owner decision, run.json acknowledgements), so a
 * reader can tell a candidate defect from a case where T7A's lexical
 * stand-in simply never selected the exchange and no rule added it.
 */
function summarizeSelectionByExchange(t: TranslatedProvenanceCase, selected: ReadonlySet<number>): string {
  const byExchange = new Map<string, number[]>();
  t.history.forEach((h, i) => {
    if (h.exchangeId === undefined) return;
    const bucket = byExchange.get(h.exchangeId);
    if (bucket) bucket.push(i);
    else byExchange.set(h.exchangeId, [i]);
  });
  const parts: string[] = [];
  for (const [exchangeId, indices] of byExchange) {
    const count = indices.filter((i) => selected.has(i)).length;
    const state = count === 0 ? "none" : count === indices.length ? "all" : `partial(${count}/${indices.length})`;
    parts.push(`${exchangeId}: ${state}`);
  }
  t.unboundHistoryIndices.forEach((historyIndex, i) => {
    parts.push(`unbound:${i}: ${selected.has(historyIndex) ? "selected" : "not selected"}`);
  });
  return parts.length > 0 ? parts.join("; ") : "(no bound or unbound turns)";
}

/** Every argument `selectWithProvenance` takes, in order -- the seam T7B's red-first stub injects through (a stub matches this same type; see `runProvenanceDevCase`'s own doc comment). */
export type ProvenanceSelector = typeof selectWithProvenance;

/** `predicted.base`/`predicted.candidate`'s free-form JSON, narrowed defensively (every committed case sets both; a case that somehow omitted one reads as the least assertive value of its own union: `"unknown"` / `"pass"`, rather than throwing). */
function readPredicted(predicted: unknown): { base: string; candidate: string } {
  const p = (predicted ?? {}) as { base?: unknown; candidate?: unknown };
  return { base: typeof p.base === "string" ? p.base : "unknown", candidate: typeof p.candidate === "string" ? p.candidate : "pass" };
}

export interface PredictedVerdict {
  claimed: string;
  verdict: "hit" | "miss" | "n/a";
}

/**
 * `predicted.base` vs. whether the RAW base decision alone (this run's own
 * `baseSelectedIndices`, scored against itself) satisfies `expect`.
 * `"unknown"` is never scored (the author declined to guess). A miss here is
 * T7A's lexical stand-in disagreeing with the author's real-encoder guess
 * about the UNMODIFIED base -- labelled a layer-(a) artifact, never a
 * fixture finding (owner decision, run.json acknowledgements).
 */
function scorePredictedBase(claimedBase: string, baseAlonePass: boolean): PredictedVerdict {
  if (claimedBase === "unknown") return { claimed: claimedBase, verdict: "n/a" };
  const expectedPass = claimedBase === "pass";
  return { claimed: claimedBase, verdict: baseAlonePass === expectedPass ? "hit" : "miss" };
}

/**
 * `predicted.candidate` vs. whether the CANDIDATE decision actually passes
 * `expect`/`anchors` (`casePass`). `"sameAsBase"` and `"pass"` both claim
 * `expect` passes (every `"sameAsBase"` claim's case also sets
 * `expect.sameAsBase: true`, which `casePass` already scores via
 * `scoreSameAsBase`); only `"fail"` claims it does not (never seen in the
 * committed dev half, but scored for completeness). A miss here is a genuine
 * finding (owner decision, run.json acknowledgements) -- never explained away
 * by the lexical stand-in, and never a reason to edit the fixture.
 */
function scorePredictedCandidate(claimedCandidate: string, casePass: boolean): PredictedVerdict {
  const expectedPass = claimedCandidate !== "fail";
  return { claimed: claimedCandidate, verdict: casePass === expectedPass ? "hit" : "miss" };
}

/**
 * One dev-half case, fully scored: the translated case run through `select`
 * (defaulting to the real `selectWithProvenance`), scored against
 * `expect`/`anchors`, plus `predicted.base`/`predicted.candidate` hit/miss
 * verdicts and a determinism check.
 */
export interface ProvenanceDevCaseResult {
  id: string;
  family: string;
  tags: string[];
  /** `expect.*`/`anchors` scored against this run's CANDIDATE decision -- the authoritative pass/fail for this case. */
  candidateScore: ExpectScore;
  anchorScore: AnchorScore;
  /** `true` iff every applicable `candidateScore` field AND both applicable `anchorScore` fields pass. This is what T7B's per-case tests assert. */
  casePass: boolean;
  /** `expect.*` scored against this run's own RAW base decision (base vs. itself) -- feeds `predictedBase` only; never asserted on its own. */
  baseAloneScore: ExpectScore;
  predictedBase: PredictedVerdict;
  predictedCandidate: PredictedVerdict;
  /** Two independent `select(...)` calls on identical inputs are bit-identical (see `decisionsMatch`). */
  determinism: { stable: boolean; detail?: string };
  /** "the base's selection for that case alongside" (owner decision) -- printed beside every `expect`/`anchors` failure and every `predicted.base` miss so a reader can classify it. */
  baseSelectionSummary: string;
  decision: ProvenanceDecision;
}

/**
 * Run one loaded dev-half {@link ProvenanceCase} through T7A's translator and
 * `select` (defaulting to the real, pure `selectWithProvenance`), then score
 * the result against its own `expect`/`predicted`/`anchors` blocks.
 *
 * @param select - injectable seam for the red-first ritual: pass a stub that
 *   always returns the base decision unchanged --
 *   `(q, h, p, scope) => selectWithProvenance(q, h, p, scope, undefined)`
 *   forces `NO_SNAPSHOT` and reuses the real base decision underneath, so it
 *   needs no separate reimplementation -- to confirm most cases go red
 *   BEFORE wiring the real function in (see the proof note for the captured
 *   before/after vitest logs). Defaults to the real `selectWithProvenance`.
 */
export function runProvenanceDevCase(c: ProvenanceCase, select: ProvenanceSelector = selectWithProvenance): ProvenanceDevCaseResult {
  const t = translateProvenanceCase(c);
  const idIndexMap = buildIdIndexMap(t);

  const decision = select(t.queryEmbedding, t.history, t.params, t.queryScopeId, t.snapshot);
  const decisionAgain = select(t.queryEmbedding, t.history, t.params, t.queryScopeId, t.snapshot);
  const stable = decisionsMatch(decision, decisionAgain);

  const selected = new Set(decision.selectedIndices);
  const baseSelected = new Set(decision.provenance.baseSelectedIndices);

  const candidateScore = scoreExpect(c.expect, idIndexMap, selected, baseSelected, decision.provenance.reason, true);
  const baseAloneScore = scoreExpect(c.expect, idIndexMap, baseSelected, baseSelected, null, false);
  const anchorScore = scoreAnchors(c.anchors, t.historyTurns, selected);

  const casePass = candidateScore.overallPass && anchorScore.evidence.status !== "fail" && anchorScore.forbidden.status !== "fail";

  const predicted = readPredicted(c.predicted);

  return {
    id: c.id,
    family: c.family ?? "(no family)",
    tags: c.tags,
    candidateScore,
    anchorScore,
    casePass,
    baseAloneScore,
    predictedBase: scorePredictedBase(predicted.base, baseAloneScore.overallPass),
    predictedCandidate: scorePredictedCandidate(predicted.candidate, casePass),
    determinism: { stable, ...(stable ? {} : { detail: "select() returned two different decisions for two calls with identical inputs" }) },
    baseSelectionSummary: summarizeSelectionByExchange(t, baseSelected),
    decision,
  };
}

/** Every failing `expect.*`/`anchors` field of one result, as `"expect.<field>: <detail>"` / `"anchors.<field>: <detail>"` lines (no header, no base-selection line -- callers compose those themselves; see `formatProvenanceCaseFailure` and `buildProvenanceDevReport`). */
function fieldFailureLines(r: ProvenanceDevCaseResult): string[] {
  const score = r.candidateScore;
  const named: ReadonlyArray<[string, ExpectFieldResult]> = [
    ["fallback", score.fallback],
    ["sameAsBase", score.sameAsBase],
    ["required", score.required],
    ["forbidden", score.forbidden],
    ["notAdded", score.notAdded],
    ["notRemoved", score.notRemoved],
    ["pinnedLimitation", score.pinnedLimitation],
  ];
  const lines = named.filter(([, v]) => v.status === "fail").map(([k, v]) => `expect.${k}: ${v.detail ?? "fail"}`);
  if (r.anchorScore.evidence.status === "fail") lines.push(`anchors.evidence: ${r.anchorScore.evidence.detail ?? "fail"}`);
  if (r.anchorScore.forbidden.status === "fail") lines.push(`anchors.forbidden: ${r.anchorScore.forbidden.detail ?? "fail"}`);
  return lines;
}

/** One-line-per-field, developer-facing explanation of why a case's per-case test went red -- every failing field, plus the base's own selection, so the failure is diagnosable without re-running anything. */
export function formatProvenanceCaseFailure(r: ProvenanceDevCaseResult): string {
  const lines = fieldFailureLines(r).map((f) => `  - ${f}`);
  return [`case ${r.id} (family ${r.family}) failed:`, ...lines, `  base selection: ${r.baseSelectionSummary}`].join("\n");
}

/**
 * Build the full per-case predicted-vs-actual table, the per-family pass/fail
 * breakdown, and the predicted.base/predicted.candidate hit/miss summaries
 * this task's verification requires. Pure formatting: never mutates
 * `results`, never reads the filesystem or reruns anything. The caller (the
 * test file) prints this and saves it into a proof note.
 */
export function buildProvenanceDevReport(results: readonly ProvenanceDevCaseResult[]): string {
  const lines: string[] = [];
  lines.push(`Provenance dev-half report -- ${results.length} cases, T7A's frozen lexical layer-(a) similarity`);
  lines.push("");

  lines.push("## Per-case predicted-vs-actual table (every case, not only the misses)");
  lines.push("id | family | casePass | predicted.base -> verdict | predicted.candidate -> verdict");
  for (const r of [...results].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`${r.id} | ${r.family} | ${r.casePass ? "pass" : "FAIL"} | ${r.predictedBase.claimed} -> ${r.predictedBase.verdict} | ${r.predictedCandidate.claimed} -> ${r.predictedCandidate.verdict}`);
  }
  lines.push("");

  lines.push("## Per-family breakdown (expect.* + anchors -- the authoritative pass/fail)");
  const byFamily = new Map<string, ProvenanceDevCaseResult[]>();
  for (const r of results) {
    const bucket = byFamily.get(r.family);
    if (bucket) bucket.push(r);
    else byFamily.set(r.family, [r]);
  }
  for (const [family, rs] of [...byFamily.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const passing = rs.filter((r) => r.casePass);
    const line = `- ${family}: ${passing.length}/${rs.length} pass`;
    lines.push(passing.length === rs.length ? line : `${line} -- FAIL: ${rs.filter((r) => !r.casePass).map((r) => r.id).join(", ")}`);
  }
  const totalPass = results.filter((r) => r.casePass).length;
  lines.push(`TOTAL: ${totalPass}/${results.length} cases pass expect.*/anchors`);
  lines.push("");

  lines.push('## predicted.base hits/misses -- layer-(a) lexical stand-in only; a miss here is NEVER a fixture finding by itself');
  const baseHits = results.filter((r) => r.predictedBase.verdict === "hit").length;
  const baseMisses = results.filter((r) => r.predictedBase.verdict === "miss").length;
  const baseNA = results.filter((r) => r.predictedBase.verdict === "n/a").length;
  lines.push(`hits=${baseHits} misses=${baseMisses} n/a(predicted "unknown")=${baseNA}`);
  for (const r of results) {
    if (r.predictedBase.verdict === "miss") lines.push(`  - MISS ${r.id} (${r.family}): predicted.base=${r.predictedBase.claimed}; base selection: ${r.baseSelectionSummary}`);
  }
  lines.push("");

  lines.push("## predicted.candidate hits/misses -- a miss here IS a genuine finding, never fixed by editing the fixture");
  const candHits = results.filter((r) => r.predictedCandidate.verdict === "hit").length;
  const candMisses = results.filter((r) => r.predictedCandidate.verdict === "miss").length;
  lines.push(`hits=${candHits} misses=${candMisses}`);
  for (const r of results) {
    if (r.predictedCandidate.verdict === "miss") {
      lines.push(`  - MISS ${r.id} (${r.family}): predicted.candidate=${r.predictedCandidate.claimed}, casePass=${r.casePass}`);
      lines.push(`    base selection: ${r.baseSelectionSummary}`);
    }
  }
  lines.push("");

  lines.push("## Every expect/anchors failure in full, with the base's own selection alongside for classification");
  const failing = results.filter((r) => !r.casePass);
  if (failing.length === 0) lines.push("(none)");
  for (const r of failing) {
    lines.push(`- ${r.id} (${r.family}):`);
    for (const f of fieldFailureLines(r)) lines.push(`    - ${f}`);
    lines.push(`    base selection: ${r.baseSelectionSummary}`);
  }
  lines.push("");

  const unstable = results.filter((r) => !r.determinism.stable);
  lines.push(`## Determinism: ${results.length - unstable.length}/${results.length} cases produced identical decisions across two calls with identical inputs`);
  for (const r of unstable) lines.push(`  - UNSTABLE ${r.id}: ${r.determinism.detail ?? ""}`);

  return lines.join("\n");
}
