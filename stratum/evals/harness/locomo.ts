/**
 * LoCoMo Tier-A dataset loader (Phase 2 / v0.4.x).
 *
 * LoCoMo (snap-research/locomo, "Evaluating Very Long-Term Conversational
 * Memory of LLM Agents", arXiv:2402.17753) is one of the three PUBLISHED Tier-A
 * benchmarks docs/EVAL_FRAMEWORK.md gates pruning on. Each of its 10 samples is
 * a multi-SESSION dialogue (19–32 sessions, ~370–690 turns) spanning WEEKS, with
 * timestamped turns and a battery of QA pairs whose answers must be retrieved
 * from somewhere in that long history — exactly the long-horizon memory the
 * temporal-decay pruner has to preserve.
 *
 * This loader is PURE (readFileSync + parsing only — no model, no API, no
 * network) and unit-tested against an inline synthetic sample (the real corpus
 * is CC-BY-NC and gitignored per ADR-0014, so tests must NOT depend on it). It
 * turns the raw JSON into:
 *   - chronological {@link LocomoTurn}s with REAL Unix timestamps (parsed from
 *     each session's date_time) so the pruner's λ^((now−t)/3600) decay operates
 *     on the dialogue's true multi-week time axis, and
 *   - a dia_id → turn-index map so a QA's `evidence` (e.g. ["D1:3"]) resolves to
 *     the exact turns that must survive pruning (a deterministic, judge-free
 *     evidence-survival signal).
 *
 * It does NOT call the encoder/judge — scripts/eval-locomo.ts wires those.
 *
 * ATTRIBUTION: LoCoMo © Snap Inc., CC BY-NC 4.0. Used here for NonCommercial
 * eval only; the data is not redistributed (gitignored). See ADR-0014.
 */

import { readFileSync } from "node:fs";

/** One dialogue turn with an absolute timestamp (chronological global order). */
export interface LocomoTurn {
  /** LoCoMo dialogue id, "D{session}:{turn}" (e.g. "D1:3"). Unique per sample. */
  diaId: string;
  /** The speaker's name. */
  speaker: string;
  /** Turn text; a shared photo's caption is appended as "[shared a photo: …]". */
  text: string;
  /** Unix timestamp (seconds, UTC) when the turn occurred (from session date_time). */
  timestampSeconds: number;
  /** 1-based session number this turn belongs to. */
  sessionIndex: number;
}

/** One QA pair to evaluate against the conversation. */
export interface LocomoQuestion {
  /** The question text. */
  query: string;
  /** The gold answer (coerced to string; LoCoMo stores numbers for some). */
  goldenAnswer: string;
  /** Evidence dia_ids that contain the answer (e.g. ["D1:3","D2:8"]). */
  evidence: string[];
  /**
   * LoCoMo category: 1 = multi-hop, 2 = temporal reasoning, 3 = open-domain
   * knowledge, 4 = single-hop, 5 = adversarial (unanswerable — the correct
   * answer is a refusal, so cat-5 tests refusal, not memory RETENTION).
   */
  category: number;
}

/** A fully-parsed LoCoMo conversation sample. */
export interface LocomoConversation {
  /** The sample id (e.g. "conv-26"). */
  sampleId: string;
  /** The two speakers. */
  speakerA: string;
  speakerB: string;
  /** All turns across all sessions, in chronological order. */
  turns: LocomoTurn[];
  /** diaId → index into {@link turns}. */
  diaIndex: Map<string, number>;
  /** The QA battery. */
  questions: LocomoQuestion[];
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const DATETIME_RE = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i;
const SESSION_KEY_RE = /^session_(\d+)$/;

/**
 * Parse a LoCoMo session date_time ("1:56 pm on 8 May, 2023") into Unix seconds
 * (UTC). UTC is used consistently so the result is machine-independent; the
 * pruner only consumes time DELTAS, for which a fixed offset cancels out.
 *
 * @param s - the LoCoMo date_time string.
 * @returns Unix timestamp in seconds (UTC).
 * @throws {Error} if the string does not match the expected LoCoMo format
 *   (fail-loud — never fabricate a timestamp, which would silently distort decay).
 */
export function parseLocomoDateTime(s: string): number {
  const m = s.trim().match(DATETIME_RE);
  if (!m) throw new Error(`unparseable LoCoMo date_time: ${JSON.stringify(s)}`);
  const [, hh, mm, ap, day, monName, year] = m;
  const monthIdx = MONTHS[(monName ?? "").toLowerCase()];
  if (monthIdx === undefined) throw new Error(`unknown month in LoCoMo date_time: ${JSON.stringify(s)}`);
  let hour = Number(hh);
  const minute = Number(mm);
  const isPm = (ap ?? "").toLowerCase() === "pm";
  if (hour === 12) hour = isPm ? 12 : 0; // 12 pm = noon, 12 am = midnight
  else if (isPm) hour += 12;
  const ms = Date.UTC(Number(year), monthIdx, Number(day), hour, minute, 0);
  return Math.floor(ms / 1000);
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Build a turn's text, appending a shared photo's caption so image-grounded evidence survives. */
function turnText(t: { text?: unknown; blip_caption?: unknown }): string {
  const base = asString(t.text).trim();
  const cap = asString(t.blip_caption).trim();
  if (cap) return base ? `${base} [shared a photo: ${cap}]` : `[shared a photo: ${cap}]`;
  return base;
}

interface RawSample {
  sample_id?: unknown;
  conversation?: Record<string, unknown>;
  qa?: unknown;
}

/** Convert one raw LoCoMo sample object into a {@link LocomoConversation}. */
function toConversation(sample: RawSample, sampleNo: number): LocomoConversation {
  const conv = sample.conversation;
  if (!conv || typeof conv !== "object") throw new Error(`LoCoMo sample ${sampleNo}: missing conversation`);
  const sampleId = asString(sample.sample_id) || `sample-${sampleNo}`;
  const speakerA = asString(conv["speaker_a"]) || "Speaker A";
  const speakerB = asString(conv["speaker_b"]) || "Speaker B";

  // Discover session_N keys and order them numerically.
  const sessionNums = Object.keys(conv)
    .map((k) => k.match(SESSION_KEY_RE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  if (sessionNums.length === 0) throw new Error(`LoCoMo sample ${sampleId}: no session_N keys`);

  const turns: LocomoTurn[] = [];
  const diaIndex = new Map<string, number>();
  for (const n of sessionNums) {
    const dt = conv[`session_${n}_date_time`];
    if (typeof dt !== "string") throw new Error(`LoCoMo sample ${sampleId}: session ${n} missing date_time`);
    const sessionEpoch = parseLocomoDateTime(dt);
    const rawTurns = conv[`session_${n}`];
    if (!Array.isArray(rawTurns)) throw new Error(`LoCoMo sample ${sampleId}: session_${n} is not an array`);
    rawTurns.forEach((rt, i) => {
      const t = rt as { speaker?: unknown; dia_id?: unknown; text?: unknown; blip_caption?: unknown };
      const text = turnText(t);
      if (!text) return; // skip a content-free turn (no text, no caption)
      const diaId = asString(t.dia_id) || `D${n}:${i + 1}`;
      // +i seconds keeps strict monotonic order within a session (sub-decay-scale
      // — sessions are hours/days apart, so this never affects λ^hours materially).
      const idx = turns.length;
      turns.push({ diaId, speaker: asString(t.speaker) || "?", text, timestampSeconds: sessionEpoch + i, sessionIndex: n });
      if (!diaIndex.has(diaId)) diaIndex.set(diaId, idx);
    });
  }
  if (turns.length === 0) throw new Error(`LoCoMo sample ${sampleId}: zero usable turns`);

  const rawQa = Array.isArray(sample.qa) ? sample.qa : [];
  const questions: LocomoQuestion[] = [];
  for (const rq of rawQa) {
    const q = rq as { question?: unknown; answer?: unknown; evidence?: unknown; category?: unknown };
    const query = asString(q.question).trim();
    if (!query) continue;
    const evidence = Array.isArray(q.evidence) ? q.evidence.map(asString).filter((e) => e.length > 0) : [];
    questions.push({
      query,
      goldenAnswer: asString(q.answer),
      evidence,
      category: typeof q.category === "number" ? q.category : 0,
    });
  }

  return { sampleId, speakerA, speakerB, turns, diaIndex, questions };
}

/**
 * Parse the LoCoMo locomo10.json contents into conversations.
 *
 * @param json - the raw file contents (a JSON array of samples).
 * @returns the parsed {@link LocomoConversation}s.
 * @throws {Error} if the JSON is not an array or any sample is malformed.
 */
export function parseLocomo(json: string): LocomoConversation[] {
  const data = JSON.parse(json) as unknown;
  if (!Array.isArray(data)) throw new Error("LoCoMo: top-level JSON is not an array");
  return data.map((s, i) => toConversation(s as RawSample, i));
}

/** Load + parse LoCoMo from a file. */
export function loadLocomo(file: string): LocomoConversation[] {
  return parseLocomo(readFileSync(file, "utf8"));
}

/**
 * Resolve a question's evidence dia_ids to turn indices within a conversation.
 *
 * @param conv - the conversation.
 * @param q - the question.
 * @returns the resolved indices (ascending) and any dia_ids that did not resolve.
 */
export function resolveEvidence(conv: LocomoConversation, q: LocomoQuestion): { indices: number[]; unresolved: string[] } {
  const indices: number[] = [];
  const unresolved: string[] = [];
  for (const e of q.evidence) {
    const idx = conv.diaIndex.get(e);
    if (idx === undefined) unresolved.push(e);
    else indices.push(idx);
  }
  return { indices: [...new Set(indices)].sort((a, b) => a - b), unresolved };
}

export interface SampleOptions {
  /** Categories to include (default [1,2,3,4] — excludes cat-5 adversarial/refusal). */
  categories?: number[];
  /** Max questions to return (after filtering); spread evenly over the timeline. */
  maxQuestions: number;
  /** Require ALL evidence dia_ids to resolve (default true → evidence-survival is well-defined). */
  requireResolvableEvidence?: boolean;
}

/**
 * Deterministically sample a conversation's questions for the gate.
 *
 * Filters to the requested categories (default: answerable cats 1–4, since cat-5
 * is adversarial/refusal and does not test memory retention) and — by default —
 * to questions whose evidence fully resolves. The survivors are ordered by their
 * EARLIEST evidence turn index, then picked at an even stride, so the sample
 * spans the conversation's whole time axis (early-session ⇢ late-session
 * evidence) rather than cherry-picking easy recent-evidence questions. Fully
 * deterministic — no RNG — so a run is reproducible.
 *
 * @param conv - the conversation.
 * @param opts - sampling options.
 * @returns the sampled questions (≤ opts.maxQuestions), timeline-spread.
 */
export function sampleQuestions(conv: LocomoConversation, opts: SampleOptions): LocomoQuestion[] {
  const cats = new Set(opts.categories ?? [1, 2, 3, 4]);
  const requireResolvable = opts.requireResolvableEvidence ?? true;

  const eligible = conv.questions
    .map((q) => ({ q, ev: resolveEvidence(conv, q) }))
    .filter(({ q, ev }) => {
      if (!cats.has(q.category)) return false;
      if (requireResolvable) return q.evidence.length > 0 && ev.unresolved.length === 0;
      return true;
    })
    .map(({ q, ev }) => ({ q, earliest: ev.indices.length ? ev.indices[0]! : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.earliest - b.earliest || a.q.query.localeCompare(b.q.query));

  const n = Math.min(opts.maxQuestions, eligible.length);
  if (n <= 0) return [];
  if (n === eligible.length) return eligible.map((e) => e.q);

  // Even stride across the timeline-sorted list.
  const out: LocomoQuestion[] = [];
  const stride = eligible.length / n;
  for (let i = 0; i < n; i++) {
    const idx = Math.min(eligible.length - 1, Math.floor(i * stride));
    out.push(eligible[idx]!.q);
  }
  return out;
}

/** Render a (subset of) turns as "Speaker: text" lines for the answerer/judge. */
export function renderTurns(turns: LocomoTurn[], indices?: number[]): string {
  const sel = indices ? indices.map((i) => turns[i]).filter((t): t is LocomoTurn => t !== undefined) : turns;
  return sel.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}
