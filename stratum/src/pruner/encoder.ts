/**
 * Bi-encoder abstraction + similarity math (Phase 2 / v0.4.x).
 *
 * The encoder turns text → a 384-d embedding (all-MiniLM-L6-v2, INT8) via ONNX
 * Runtime, client-side, never networked. Embeddings are L2-normalized so a dot
 * product == cosine similarity (docs/ALGORITHM.md §ONNX Runtime).
 *
 * The pure similarity math here (l2Normalize, cosineSimilarity) is unit-tested
 * and used by the orchestrator. The REAL text→embedding path (createOnnxEncoder)
 * is GATED on the model artifact (all-MiniLM-L6-v2-int8.onnx) + a matching
 * tokenizer, which are NOT in the repo — it throws a clear error rather than
 * returning garbage embeddings (garbage would silently corrupt pruning). The
 * orchestrator (pruner.ts) consumes EMBEDDINGS, so it is fully testable without
 * the model via an injected/test encoder.
 */

export const EMBEDDING_DIM = 384;

/** A bi-encoder: text → L2-normalized embeddings. */
export interface BiEncoder {
  /** Encode a batch of texts into L2-normalized embedding vectors. */
  encode(texts: string[]): Promise<Float32Array[]>;
  /** Output dimension (e.g. 384 for all-MiniLM-L6-v2). */
  readonly dimension: number;
}

/** L2-normalize a vector in place (returns it). Zero vector is left unchanged. */
export function l2Normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

/** Dot product — equals cosine similarity when both vectors are L2-normalized. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export interface OnnxEncoderOptions {
  /** Path to the INT8 ONNX model (all-MiniLM-L6-v2-int8.onnx). */
  modelPath: string;
}

/**
 * Create the real ONNX-backed encoder.
 *
 * @param opts - model path.
 * @returns a {@link BiEncoder}.
 * @throws ALWAYS until the model artifact is provided — the
 *   all-MiniLM-L6-v2 INT8 model + matching tokenizer are not in the repo.
 *   Failing loudly is deliberate: silently returning fake embeddings would
 *   corrupt every downstream pruning decision. Provide the model (and wire
 *   onnxruntime-node + the tokenizer here) to enable real embeddings.
 */
export async function createOnnxEncoder(opts: OnnxEncoderOptions): Promise<BiEncoder> {
  throw new Error(
    `ONNX encoder unavailable: model artifact required at "${opts.modelPath}" ` +
      `(all-MiniLM-L6-v2 INT8) plus a matching tokenizer — neither is in the repo. ` +
      `See docs/ALGORITHM.md §ONNX Runtime. Until provided, supply a test/injected ` +
      `BiEncoder. (Real inference + tokenization are wired here once the model exists.)`,
  );
}
