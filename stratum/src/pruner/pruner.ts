/**
 * Pruner Orchestrator
 *
 * Coordinates the ONNX encoder and KadaneDial algorithm
 * to select relevant spans from session history.
 *
 * Flow:
 *   1. Encode new query (ONNX, < 10ms)
 *   2. Compute relevance scores with temporal decay
 *   3. Run KadaneDial span selection
 *   4. Return selected spans for context assembly
 */

// TODO: Implement pruner orchestrator (Phase 2)
