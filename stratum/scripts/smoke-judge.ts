/**
 * Live judge smoke test (MANUAL — spends a tiny bit of real API credit).
 *
 * Verifies the LLM-as-judge (evals/harness/metrics.ts) against the REAL model:
 * a faithful answer must score high on faithfulness, a contradicted answer must
 * score low, and the answerer must answer from context. ~3 Haiku calls.
 *
 * NOT a vitest test + NOT in CI. Run on demand:
 *   ANTHROPIC_API_KEY=... npm run smoke:judge
 * Gated: prints how to run + exits 0 if no key.
 */

import { createClaudeAnswerer, createLlmJudge } from "../evals/harness/metrics";

const CONTEXT = "Project decision (turn 12): we migrated the database from Postgres to Supabase. The chosen client library is @supabase/supabase-js.";
const QUERY = "Which database did we decide to use?";

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  if (!process.env["ANTHROPIC_API_KEY"]) {
    out("Judge smoke test GATED: set ANTHROPIC_API_KEY to run.  ANTHROPIC_API_KEY=... npm run smoke:judge");
    return 0;
  }

  const judge = createLlmJudge();
  const answerer = createClaudeAnswerer();

  out("→ scoring a FAITHFUL answer vs a CONTRADICTED answer (real Claude judge)");
  const faithful = await judge.score({ query: QUERY, context: CONTEXT, answer: "We decided to use Supabase." });
  const hallucinated = await judge.score({ query: QUERY, context: CONTEXT, answer: "We decided to use MongoDB." });
  out("→ answerer generating from context");
  const generated = await answerer.generate(QUERY, CONTEXT);

  const checks: { name: string; ok: boolean; detail: string }[] = [
    { name: "faithful answer scores high (≥0.8)", ok: faithful.faithfulness >= 0.8, detail: `faithfulness=${faithful.faithfulness}` },
    { name: "contradicted answer scores low (≤0.5)", ok: hallucinated.faithfulness <= 0.5, detail: `faithfulness=${hallucinated.faithfulness}` },
    { name: "judge discriminates (faithful > contradicted)", ok: faithful.faithfulness > hallucinated.faithfulness, detail: `${faithful.faithfulness} > ${hallucinated.faithfulness}` },
    { name: "faithful answer is relevant (≥0.7)", ok: faithful.answerRelevancy >= 0.7, detail: `answerRelevancy=${faithful.answerRelevancy}` },
    { name: "answerer answers from context", ok: /supabase/i.test(generated), detail: `answer="${generated.slice(0, 60)}"` },
  ];

  out("");
  for (const c of checks) out(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  const passed = checks.every((c) => c.ok);
  out("");
  out(passed ? "RESULT: PASS — LLM judge + answerer verified against the real model." : "RESULT: FAIL — see checks above.");
  return passed ? 0 : 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("smoke-judge.ts") || entryPath.endsWith("smoke-judge.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
