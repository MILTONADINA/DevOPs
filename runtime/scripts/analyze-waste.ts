/**
 * Waste analysis CLI (§2b→§2c) — run the Phase-1 waste detectors over the
 * captured corpus (data/sessions/session-*.json) and print the ranked findings
 * + the candidate #1 waste type. Reuses readSessionsFromDir + buildDashboardData
 * (the same aggregation the /dashboard API serves). Output feeds the
 * docs/waste-taxonomy.md #1-waste finding that calibrates the Phase-2 pruner.
 *
 * Usage: npm run analyze-waste [-- <sessions-dir>]
 */

import { join } from "node:path";
import { readSessionsFromDir } from "../src/proxy/routes/dashboard";
import { buildDashboardData } from "../src/proxy/dashboard-data";

export function main(argv: string[] = []): number {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const dir = argv[0] ?? join(process.cwd(), "data", "sessions");
  const sessions = readSessionsFromDir(dir);
  if (sessions.length === 0) {
    out(`No session-*.json found in ${dir}.`);
    out("Run `npm run import-sessions` (bootstrap from existing transcripts) or `npm run dev` (live capture) first.");
    return 0;
  }

  const d = buildDashboardData(sessions);
  out(`CQ Waste Analysis — Phase 1   (corpus: ${dir})`);
  out("=".repeat(64));
  out(`sessions: ${d.session_count}   turns: ${d.total_turns}   dropped: ${d.total_dropped_turns}`);
  out(`input tokens (reported): ${d.total_input_tokens.toLocaleString()}   output tokens: ${d.total_output_tokens.toLocaleString()}`);
  out(`rough est. cost: $${d.estimated_cost_usd}`);
  out("");
  out("Ranked waste findings (estimated re-sent/redundant tokens, desc):");
  if (d.waste.length === 0) {
    out("  (none detected — system/tool repetition need live-proxy capture; imported turns omit them)");
  }
  for (const w of d.waste) {
    out(`  [${w.severity.toUpperCase().padEnd(6)}] ${w.type.padEnd(28)} ~${w.token_estimate.toLocaleString()} tok`);
    out(`            ${w.description}`);
  }
  out("");
  out(`>>> Candidate #1 waste type: ${d.top_waste_type ?? "—"}`);
  out("");
  out("Per session:");
  for (const s of d.sessions) {
    out(`  ${s.session_id.slice(0, 28).padEnd(28)} turns=${String(s.turns).padStart(5)}  in=${s.input_tokens.toLocaleString().padStart(10)}  out=${s.output_tokens.toLocaleString().padStart(11)}`);
  }
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("analyze-waste.ts") || entryPath.endsWith("analyze-waste.js")) {
  process.exitCode = main(process.argv.slice(2));
}
