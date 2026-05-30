/**
 * Phase 1 waste-detection heuristics (§2d).
 *
 * Pure `detect(session) → WasteFinding[]` functions over a captured session.
 * These MEASURE token waste (Phase 1); they do NOT prune (Phase 2). Each
 * detector is a building block for the Phase-2 KadaneDial pruner's heuristics.
 *
 * IMPORTANT CALIBRATION CAVEAT: the token_estimate values are HEURISTIC
 * (chars/4 + coarse context-tax math) because per-message exact token
 * breakdowns are not yet captured (deferred token-counting enhancement). The
 * RANKING of waste categories — especially the load-bearing "#1 waste type"
 * that drives Phase-2 pruner priorities (plan.md §2b) — MUST be validated
 * against the real §2b capture corpus. Do not treat these estimates as
 * provable billing figures; they are directional signal for prioritization.
 */

import type { CaptureSession } from "./capture";

export type WasteSeverity = "low" | "medium" | "high";

export interface WasteFinding {
  /** Stable machine key for the waste category. */
  type: string;
  severity: WasteSeverity;
  /** Heuristic estimate of re-sent / redundant input tokens (NOT provable). */
  token_estimate: number;
  /** Where in the session the waste occurs. */
  location: string;
  /** Human-readable explanation. */
  description: string;
}

/** Coarse token estimate (~chars/4). Heuristic only — see file header. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function severityFor(tokens: number): WasteSeverity {
  if (tokens >= 5000) return "high";
  if (tokens >= 1000) return "medium";
  return "low";
}

/** Best-effort flatten of an Anthropic message content (string | block[]) to text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const r = b as Record<string, unknown>;
        return typeof r["text"] === "string" ? (r["text"] as string) : JSON.stringify(b);
      })
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

function messagesOf(session: CaptureSession, turnIdx: number): Array<Record<string, unknown>> {
  const msgs = session.requests[turnIdx]?.request.messages;
  return Array.isArray(msgs) ? (msgs as Array<Record<string, unknown>>) : [];
}

/** Detector: an identical system prompt re-sent on every turn. */
export function detectSystemRepetition(session: CaptureSession): WasteFinding[] {
  const systems = session.requests.map((r) => r.request.system).filter((s): s is unknown => s !== undefined);
  if (systems.length < 2) return [];
  const firstKey = JSON.stringify(systems[0]);
  if (!systems.every((s) => JSON.stringify(s) === firstKey)) return [];
  const perTurn = estimateTokens(contentToText(systems[0]));
  const wasted = perTurn * (systems.length - 1);
  if (wasted <= 0) return [];
  return [
    {
      type: "system_prompt_repetition",
      severity: severityFor(wasted),
      token_estimate: wasted,
      location: `system prompt across ${systems.length} turns`,
      description: `Identical system prompt re-sent ${systems.length}× (~${perTurn} tok each) → ~${wasted} tok of re-sent overhead.`,
    },
  ];
}

/** Detector: identical tool definitions re-sent on every turn. */
export function detectToolRepetition(session: CaptureSession): WasteFinding[] {
  const tools = session.requests.map((r) => r.request.tools).filter((t): t is unknown => t !== undefined);
  if (tools.length < 2) return [];
  const firstKey = JSON.stringify(tools[0]);
  if (!tools.every((t) => JSON.stringify(t) === firstKey)) return [];
  const perTurn = estimateTokens(JSON.stringify(tools[0]));
  const wasted = perTurn * (tools.length - 1);
  if (wasted <= 0) return [];
  return [
    {
      type: "tool_definitions_repetition",
      severity: severityFor(wasted),
      token_estimate: wasted,
      location: `tools[] across ${tools.length} turns`,
      description: `Identical tool definitions re-sent ${tools.length}× (~${perTurn} tok each) → ~${wasted} tok of re-sent overhead.`,
    },
  ];
}

/**
 * Detector: the "context tax" — Claude Code re-sends the growing conversation
 * history every turn, so cumulative input far exceeds the single largest
 * context. token_estimate = total_input − peak_single_turn (re-sent overhead).
 */
export function detectContextTax(session: CaptureSession): WasteFinding[] {
  const inputs = session.requests.map((r) => r.token_counts.input_tokens).filter((n) => n > 0);
  if (inputs.length < 2) return [];
  const total = inputs.reduce((a, b) => a + b, 0);
  const peak = Math.max(...inputs);
  const reSent = total - peak;
  if (reSent <= 0) return [];
  const monotonic = inputs.every((v, i, a) => i === 0 || v >= (a[i - 1] ?? 0));
  return [
    {
      type: "context_tax",
      severity: severityFor(reSent),
      token_estimate: reSent,
      location: `${inputs.length} turns`,
      description: `Cumulative input ${total} tok vs peak single-turn ${peak} tok → ~${reSent} tok of re-sent context${monotonic ? " (monotonic growth)" : ""}. HEURISTIC — precise per-turn-new-content needs per-message token breakdown (deferred); calibrate against the §2b corpus.`,
    },
  ];
}

/**
 * Detector: large message contents (≥200 chars) that recur across turns beyond
 * the natural history resend — e.g. a big paste echoed many times.
 */
export function detectDuplicateContent(session: CaptureSession): WasteFinding[] {
  const seen = new Map<string, number>();
  for (let i = 0; i < session.requests.length; i++) {
    for (const m of messagesOf(session, i)) {
      const text = contentToText(m["content"]);
      if (text.length < 200) continue;
      seen.set(text, (seen.get(text) ?? 0) + 1);
    }
  }
  let dupTokens = 0;
  let dupBlocks = 0;
  for (const [text, n] of seen) {
    if (n >= 2) {
      dupTokens += estimateTokens(text) * (n - 1);
      dupBlocks++;
    }
  }
  if (dupTokens <= 0) return [];
  return [
    {
      type: "duplicate_message_content",
      severity: severityFor(dupTokens),
      token_estimate: dupTokens,
      location: `${dupBlocks} large content block(s) repeated`,
      description: `${dupBlocks} large message block(s) (≥200 chars) appear in multiple turns → ~${dupTokens} tok of duplicated content beyond first send.`,
    },
  ];
}

export const WASTE_DETECTORS = [detectSystemRepetition, detectToolRepetition, detectContextTax, detectDuplicateContent] as const;

/**
 * Run all waste detectors over a session, returning findings sorted by
 * estimated token waste (descending). The top finding is the candidate
 * "#1 waste type" — but confirm against the real §2b corpus before acting.
 *
 * @param session - a captured session.
 * @returns waste findings, highest token_estimate first.
 */
export function runWasteDetectors(session: CaptureSession): WasteFinding[] {
  return WASTE_DETECTORS.flatMap((d) => d(session)).sort((a, b) => b.token_estimate - a.token_estimate);
}
