/**
 * Dashboard data aggregation (§2d) — pure, testable.
 *
 * Folds a set of captured sessions into the JSON the /dashboard view renders:
 * per-session summaries, totals, a rough $ estimate, and aggregated waste
 * findings (top waste type first). No I/O — the route injects the sessions.
 */

import type { CaptureSession } from "./capture";
import { runWasteDetectors, type WasteFinding } from "./waste";

export interface CostRates {
  /** USD per 1M input tokens. */
  input_per_mtok: number;
  /** USD per 1M output tokens. */
  output_per_mtok: number;
}

/** Rough Opus-class rates (USD / 1M tokens). Estimate only — see DashboardData.note. */
export const DEFAULT_RATES: CostRates = { input_per_mtok: 15, output_per_mtok: 75 };

export interface SessionSummary {
  session_id: string;
  started_at: string;
  ended_at?: string | undefined;
  turns: number;
  dropped_turns: number;
  input_tokens: number;
  output_tokens: number;
}

export interface DashboardData {
  note: string;
  session_count: number;
  total_turns: number;
  total_dropped_turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  estimated_cost_usd: number;
  sessions: SessionSummary[];
  /** Waste findings aggregated across all sessions, highest token_estimate first. */
  waste: WasteFinding[];
  /** Candidate #1 waste type (validate against the §2b corpus before acting). */
  top_waste_type: string | null;
}

function estimateCostUsd(inputTok: number, outputTok: number, rates: CostRates): number {
  return (inputTok / 1e6) * rates.input_per_mtok + (outputTok / 1e6) * rates.output_per_mtok;
}

/**
 * Aggregate captured sessions into dashboard data.
 *
 * @param sessions - captured sessions (already redacted on disk).
 * @param rates - cost rates (default {@link DEFAULT_RATES}).
 * @returns the {@link DashboardData} for rendering / the JSON API.
 */
export function buildDashboardData(sessions: CaptureSession[], rates: CostRates = DEFAULT_RATES): DashboardData {
  // Coerce missing/non-numeric fields to 0: older or partial artifacts (e.g.
  // pre-`dropped_turns` captures) must not poison the aggregate with NaN.
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const summaries: SessionSummary[] = sessions.map((s) => ({
    session_id: s.session_id,
    started_at: s.started_at,
    ended_at: s.ended_at,
    turns: n(s.total_turns),
    dropped_turns: n(s.dropped_turns),
    input_tokens: n(s.total_input_tokens),
    output_tokens: n(s.total_output_tokens),
  }));

  const total_turns = summaries.reduce((a, s) => a + s.turns, 0);
  const total_dropped_turns = summaries.reduce((a, s) => a + s.dropped_turns, 0);
  const total_input_tokens = summaries.reduce((a, s) => a + s.input_tokens, 0);
  const total_output_tokens = summaries.reduce((a, s) => a + s.output_tokens, 0);

  // Aggregate waste findings across sessions, merged by type (summed estimate).
  const byType = new Map<string, WasteFinding>();
  for (const s of sessions) {
    for (const f of runWasteDetectors(s)) {
      const prev = byType.get(f.type);
      if (prev) {
        prev.token_estimate += f.token_estimate;
        prev.severity = f.token_estimate + prev.token_estimate >= 5000 ? "high" : prev.severity;
      } else {
        byType.set(f.type, { ...f, location: "across sessions" });
      }
    }
  }
  const waste = [...byType.values()].sort((a, b) => b.token_estimate - a.token_estimate);

  return {
    note: "Phase 1 measurement. Token counts are exact where token_count_method=exact; $ and waste estimates are ROUGH heuristics — calibrate against the §2b corpus.",
    session_count: sessions.length,
    total_turns,
    total_dropped_turns,
    total_input_tokens,
    total_output_tokens,
    estimated_cost_usd: Number(estimateCostUsd(total_input_tokens, total_output_tokens, rates).toFixed(4)),
    sessions: summaries,
    waste,
    top_waste_type: waste[0]?.type ?? null,
  };
}
