/**
 * LongMemEval Tier-A loader (Phase 2 / v0.4.x) — the SECOND long-horizon
 * conversational-memory benchmark (after LoCoMo), per the Tier-A triage (ADR-0014
 * / EVAL_FRAMEWORK §Tier A). Validating the decay calibration (ADR-0015) on >1
 * benchmark guards against over-fitting to LoCoMo.
 *
 * LongMemEval (xiaowu0162/LongMemEval, *LongMemEval: Benchmarking Chat Assistants
 * on Long-Term Interactive Memory*, ICLR 2025) — **MIT-licensed**. Unlike LoCoMo
 * (one conversation, many QAs), EACH QUESTION carries its OWN haystack of chat
 * sessions, and gold evidence is marked at the TURN level (`has_answer: true`),
 * so evidence resolution is direct (no id mapping). 500 questions across 6 types
 * (single-session-user/assistant/preference, multi-session, temporal-reasoning,
 * knowledge-update).
 *
 * PURE (readFileSync + parsing only — no model/API/network) and unit-tested
 * against an inline synthetic record (the corpus is fetched on demand + gitignored,
 * like LoCoMo). Mirrors the LoCoMo loader's shape so the same prune→survival
 * machinery applies.
 *
 * ATTRIBUTION: LongMemEval © Di Wu et al., MIT License.
 */

import { readFileSync } from "node:fs";

/** One dialogue turn within a question's haystack (chronological). */
export interface LongMemTurn {
  /** "user" | "assistant" (verbatim from the dataset). */
  role: string;
  /** Turn text. */
  text: string;
  /** Unix timestamp (seconds, UTC) from the session's haystack date. */
  timestampSeconds: number;
  /** 0-based session index within this question's haystack. */
  sessionIndex: number;
  /** Gold-evidence flag (the dataset's `has_answer`). */
  hasAnswer: boolean;
}

/** One LongMemEval question + its own haystack + gold evidence. */
export interface LongMemQuestion {
  questionId: string;
  /** single-session-user | single-session-assistant | single-session-preference | multi-session | temporal-reasoning | knowledge-update. */
  questionType: string;
  query: string;
  goldenAnswer: string;
  /** This question's haystack, flattened to chronological turns. */
  turns: LongMemTurn[];
  /** Indices into {@link turns} that are gold evidence (has_answer). */
  evidenceIndices: number[];
}

const DATETIME_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s*\([^)]*\)\s*(\d{1,2}):(\d{2})/;

/**
 * Parse a LongMemEval haystack date ("2023/04/10 (Mon) 17:50") into Unix seconds
 * (UTC). UTC is used consistently (the pruner only consumes time deltas).
 *
 * @param s - the date string.
 * @returns Unix timestamp in seconds (UTC).
 * @throws {Error} if unparseable (fail-loud — never fabricate a timestamp).
 */
export function parseLongMemDateTime(s: string): number {
  const m = s.trim().match(DATETIME_RE);
  if (!m) throw new Error(`unparseable LongMemEval date: ${JSON.stringify(s)}`);
  const [, year, mon, day, hh, mm] = m;
  const monthIdx = Number(mon) - 1;
  const d = Number(day);
  const hour = Number(hh);
  const minute = Number(mm);
  // Range-check BEFORE Date.UTC (which silently rolls overflow, fabricating a wrong
  // epoch — the opposite of the fail-loud contract).
  if (monthIdx < 0 || monthIdx > 11 || d < 1 || d > 31 || hour > 23 || minute > 59) {
    throw new Error(`out-of-range LongMemEval date: ${JSON.stringify(s)}`);
  }
  const ms = Date.UTC(Number(year), monthIdx, d, hour, minute, 0);
  const back = new Date(ms);
  if (back.getUTCMonth() !== monthIdx || back.getUTCDate() !== d) {
    throw new Error(`out-of-range LongMemEval date: ${JSON.stringify(s)}`); // e.g. 31 Feb normalized away
  }
  return Math.floor(ms / 1000);
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

interface RawRecord {
  question_id?: unknown;
  question_type?: unknown;
  question?: unknown;
  answer?: unknown;
  haystack_dates?: unknown;
  haystack_sessions?: unknown;
}

/** Convert one raw LongMemEval record into a {@link LongMemQuestion}. */
function toQuestion(rec: RawRecord, idx: number): LongMemQuestion {
  const questionId = asString(rec.question_id) || `q-${idx}`;
  const query = asString(rec.question).trim();
  const sessions = rec.haystack_sessions;
  const dates = rec.haystack_dates;
  if (!Array.isArray(sessions)) throw new Error(`LongMemEval ${questionId}: haystack_sessions not an array`);
  if (!Array.isArray(dates)) throw new Error(`LongMemEval ${questionId}: haystack_dates not an array`);

  const turns: LongMemTurn[] = [];
  const evidenceIndices: number[] = [];
  let prevMaxTs = -1; // running watermark → GLOBALLY monotonic timestamps across sessions
  sessions.forEach((rawSession, si) => {
    if (!Array.isArray(rawSession)) return;
    const dateStr = asString(dates[si]);
    // Fail-LOUD on a missing date (consistent with parseLongMemDateTime) rather than
    // synthesizing a 1970 epoch (si*3600), which would place the session ~53 years before
    // the others — breaking chronological order + corrupting the evidence-survival signal.
    if (!dateStr) throw new Error(`LongMemEval ${questionId}: session ${si} has no haystack_date`);
    const sessionEpoch = parseLongMemDateTime(dateStr);
    // base = max(epoch, prevMax+1): a session never starts before the previous ended, so
    // the flattened turn list is monotonic for ANY input (+ti gives intra-session order).
    const base = Math.max(sessionEpoch, prevMaxTs + 1);
    rawSession.forEach((rt, ti) => {
      const t = rt as { role?: unknown; content?: unknown; has_answer?: unknown };
      const text = asString(t.content).trim();
      if (!text) return;
      const hasAnswer = t.has_answer === true;
      const gi = turns.length;
      turns.push({ role: asString(t.role) || "?", text, timestampSeconds: base + ti, sessionIndex: si, hasAnswer });
      if (hasAnswer) evidenceIndices.push(gi);
    });
    prevMaxTs = base + Math.max(0, rawSession.length - 1);
  });

  return {
    questionId,
    questionType: asString(rec.question_type) || "unknown",
    query,
    goldenAnswer: asString(rec.answer),
    turns,
    evidenceIndices,
  };
}

/**
 * Parse LongMemEval JSON (an array of question records) into questions.
 *
 * @param json - the raw file contents.
 * @returns the parsed {@link LongMemQuestion}s.
 * @throws {Error} if the JSON is not an array or a record is malformed.
 */
export function parseLongMemEval(json: string): LongMemQuestion[] {
  const data = JSON.parse(json) as unknown;
  if (!Array.isArray(data)) throw new Error("LongMemEval: top-level JSON is not an array");
  return data.map((r, i) => toQuestion(r as RawRecord, i));
}

/** Load + parse LongMemEval from a file. */
export function loadLongMemEval(file: string): LongMemQuestion[] {
  return parseLongMemEval(readFileSync(file, "utf8"));
}

export interface LongMemSampleOptions {
  /** Question types to include (default: all). */
  types?: string[];
  /** Max questions to return; spread evenly across the (filtered) set. */
  maxQuestions: number;
  /** Require ≥1 gold-evidence turn (default true — so evidence survival is defined). */
  requireEvidence?: boolean;
}

/**
 * Deterministically sample questions (no RNG → reproducible). Filters to the
 * requested types + (by default) to questions with resolvable gold evidence, then
 * picks at an even stride across the filtered list (stable order by questionId).
 *
 * @param questions - all parsed questions.
 * @param opts - sampling options.
 * @returns ≤ opts.maxQuestions questions.
 */
export function sampleLongMemQuestions(questions: LongMemQuestion[], opts: LongMemSampleOptions): LongMemQuestion[] {
  const types = opts.types ? new Set(opts.types) : null;
  const requireEvidence = opts.requireEvidence ?? true;
  const eligible = questions
    .filter((q) => (types ? types.has(q.questionType) : true))
    .filter((q) => (requireEvidence ? q.evidenceIndices.length > 0 : true))
    .filter((q) => q.query.length > 0)
    .sort((a, b) => a.questionId.localeCompare(b.questionId));

  const n = Math.min(opts.maxQuestions, eligible.length);
  if (n <= 0) return [];
  if (n === eligible.length) return eligible;
  if (n === 1) return [eligible[0]!];
  // Endpoint-inclusive stride (i=0 → first, i=n-1 → last) so the sample spans the whole
  // set incl. the last element — plain floor(i·len/n) drops it (review #3).
  const out: LongMemQuestion[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    let idx = Math.round((i * (eligible.length - 1)) / (n - 1));
    while (seen.has(idx) && idx < eligible.length - 1) idx++;
    seen.add(idx);
    out.push(eligible[idx]!);
  }
  return out;
}

/** Render a (subset of) turns as "role: text" lines for the answerer/judge. */
export function renderLongMemTurns(turns: LongMemTurn[], indices?: number[]): string {
  const sel = indices ? indices.map((i) => turns[i]).filter((t): t is LongMemTurn => t !== undefined) : turns;
  return sel.map((t) => `${t.role}: ${t.text}`).join("\n");
}
