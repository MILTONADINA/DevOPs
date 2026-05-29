/**
 * Verify the real ONNX encoder (MANUAL — first run downloads ~23MB all-MiniLM
 * to the gitignored models/ cache). Encodes sentences and checks the embeddings
 * are sane: 384-d, unit-normalized, and semantically ordered (a similar pair
 * scores higher than a dissimilar pair). Proves real embeddings work end-to-end
 * without committing a model.
 *
 *   npm run verify-encoder
 */

import { join } from "node:path";
import { createOnnxEncoder, cosineSimilarity, EMBEDDING_DIM } from "../src/pruner/encoder";

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  const enc = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
  out("→ loading all-MiniLM-L6-v2 (INT8) + encoding (first run downloads the model)…");

  const texts = [
    "How do I read a file from disk in Node.js?",
    "What is the way to load a file's contents in Node?", // semantically close to [0]
    "The capital of France is Paris.", // unrelated
  ];
  const vecs = await enc.encode(texts);
  const [a, b, c] = vecs;
  if (!a || !b || !c) {
    out("FAIL: encoder returned fewer vectors than inputs.");
    return 1;
  }

  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const simClose = cosineSimilarity(a, b);
  const simFar = cosineSimilarity(a, c);

  const checks: { name: string; ok: boolean; detail: string }[] = [
    { name: "embedding dimension is 384", ok: a.length === EMBEDDING_DIM, detail: `dim=${a.length}` },
    { name: "embeddings are L2-normalized (‖v‖≈1)", ok: Math.abs(norm - 1) < 1e-3, detail: `‖a‖=${norm.toFixed(4)}` },
    { name: "similar pair scores higher than unrelated", ok: simClose > simFar, detail: `close=${simClose.toFixed(3)} > far=${simFar.toFixed(3)}` },
    { name: "similar pair is meaningfully high (>0.5)", ok: simClose > 0.5, detail: `close=${simClose.toFixed(3)}` },
    { name: "unrelated pair is low (<0.5)", ok: simFar < 0.5, detail: `far=${simFar.toFixed(3)}` },
  ];

  out("");
  for (const ch of checks) out(`  ${ch.ok ? "✓" : "✗"} ${ch.name} — ${ch.detail}`);
  const passed = checks.every((ch) => ch.ok);
  out("");
  out(passed ? "RESULT: PASS — real ONNX embeddings verified." : "RESULT: FAIL — see checks above.");
  return passed ? 0 : 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("verify-encoder.ts") || entryPath.endsWith("verify-encoder.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
