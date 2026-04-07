/**
 * ONNX Bi-Encoder Wrapper
 *
 * Runs the local ONNX model (all-MiniLM-L6-v2, INT8 quantized)
 * to produce 384-dimensional embeddings per dialogue turn.
 *
 * Performance target: < 10ms p99 on MacBook M2.
 * The model runs entirely client-side and never sees the network.
 */

// TODO: Implement ONNX encoder (Phase 2)
