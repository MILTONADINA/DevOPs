/**
 * Bi-encoder abstraction + similarity math (Phase 2 / v0.4.x).
 *
 * The encoder turns text → a 384-d embedding (all-MiniLM-L6-v2, INT8) via ONNX
 * Runtime, client-side, never networked. Embeddings are L2-normalized so a dot
 * product == cosine similarity (docs/ALGORITHM.md §ONNX Runtime).
 *
 * The pure similarity math here (l2Normalize, cosineSimilarity) is unit-tested
 * and used by the orchestrator. The REAL text→embedding path (createOnnxEncoder)
 * is backed by @huggingface/transformers (ONNX Runtime + WordPiece tokenizer,
 * ADR-0010); the model is FETCHED on first use to a gitignored cache (no binary
 * in the repo) and loaded LAZILY, so unit tests that inject embeddings never hit
 * the network. The orchestrator (pruner.ts) consumes EMBEDDINGS, so it stays
 * fully testable without the model via an injected/test encoder; real embeddings
 * are exercised by `npm run verify-encoder`.
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
  /** HF model id (ONNX weights). Default: the all-MiniLM-L6-v2 ONNX export. */
  modelId?: string;
  /** Local cache dir for the fetched model (gitignored). Default: <cwd>/models. */
  cacheDir?: string;
  /** Quantization: "q8" = INT8 (default, per docs), "fp32" = full precision. */
  dtype?: "q8" | "fp32";
}

/** Minimal shape of the transformers.js feature-extraction output we use. */
interface FeatureTensor {
  tolist(): number[][];
}
type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<FeatureTensor>;

/**
 * Create the real ONNX-backed encoder (all-MiniLM-L6-v2, INT8, L2-normalized).
 *
 * Backed by `@huggingface/transformers`, which runs the ONNX export on ONNX
 * Runtime (Node) and supplies the matching WordPiece tokenizer — see ADR-0010
 * for why this beats hand-rolling tokenization over raw onnxruntime-node. The
 * model is FETCHED on first use to a gitignored cache dir (no binary in the
 * repo). Mean-pooled + L2-normalized → a 384-d unit vector, so a dot product is
 * cosine similarity (docs/ALGORITHM.md §ONNX Runtime).
 *
 * The model load is LAZY (first non-empty `encode()`), so constructing the
 * encoder + encoding `[]` never touches the network — keeping callers testable.
 *
 * @param opts - model id / cache dir / quantization.
 * @returns a {@link BiEncoder}.
 */
export function createOnnxEncoder(opts: OnnxEncoderOptions = {}): BiEncoder {
  const modelId = opts.modelId ?? "Xenova/all-MiniLM-L6-v2";
  const dtype = opts.dtype ?? "q8";
  let extractorPromise: Promise<Extractor> | null = null;

  const getExtractor = (): Promise<Extractor> => {
    if (!extractorPromise) {
      extractorPromise = (async (): Promise<Extractor> => {
        // Dynamic import: transformers.js is ESM + heavy; only load it when an
        // encode actually happens (never during unit tests that inject vectors).
        const tf = (await import("@huggingface/transformers")) as unknown as {
          pipeline: (task: string, model: string, opts: { dtype: string }) => Promise<Extractor>;
          env: { cacheDir?: string };
        };
        if (opts.cacheDir) tf.env.cacheDir = opts.cacheDir;
        return tf.pipeline("feature-extraction", modelId, { dtype });
      })();
    }
    return extractorPromise;
  };

  // all-MiniLM-L6-v2 embeds only its first ~256 tokens; an un-capped huge input
  // (e.g. a 100K-char tool result) builds an O(seq²) attention matrix that OOMs
  // ONNX Runtime. ~1200 chars ≈ the model's 256-token window, so capping costs
  // no signal the model would have used anyway.
  const MAX_INPUT_CHARS = 1200;
  // Micro-batch: the attention tensor is batch × heads × seq² (padded to the
  // batch's longest). A 200-wide batch at seq≈512 alloc ≈ 2.5 GB → OOM. 16 keeps
  // it well bounded regardless of how many texts a caller passes at once.
  const BATCH = 16;

  return {
    dimension: EMBEDDING_DIM,
    async encode(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const extractor = await getExtractor();
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const capped = texts.slice(i, i + BATCH).map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t));
        const res = await extractor(capped, { pooling: "mean", normalize: true });
        for (const v of res.tolist()) out.push(Float32Array.from(v));
      }
      return out;
    },
  };
}
