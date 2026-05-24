# ADR-0003: Hybrid-Local Pruning for ZK-Context

**Date:** 2026-04-06
**Status:** Accepted

## Context

CQ's security promise is that raw customer context never transits the network in plaintext. However, the pruning engine must read context to prune it. This creates a fundamental paradox: if we encrypt context before sending it to the proxy, the proxy cannot run KadaneDial on it.

Three approaches were considered.

## Decision

Use Hybrid-Local Pruning: KadaneDial runs client-side (on the developer's machine) using a small ONNX model. Only the selected spans are encrypted and sent to the proxy. Decryption occurs inside an AWS Nitro Enclave (TEE) before forwarding to the LLM API.

## Consequences

- Client must run an ONNX model locally (adds ~10ms per turn)
- Client device becomes a security boundary (not ideal but necessary)
- Raw context never leaves the client unencrypted
- TEE attestation allows clients to verify no operator can read their data
- Incremental: ZK-Context is a toggle — organizations can opt in for Enterprise tier

## Alternatives Considered

**Homomorphic Encryption (HE):** Allows computation on encrypted data without decryption. Theoretically ideal. Rejected because HE is approximately 1000× slower than plaintext computation. KadaneDial on a 200-turn session would take minutes, not milliseconds. Incompatible with the <50ms latency target.

**Server-side pruning (plaintext):** The proxy receives plaintext context, prunes it, and forwards to the LLM. Simple and fast. Rejected because it requires customers to trust CQ operators with their raw code and conversations — a non-starter for enterprise sales.

**Client-side full encryption (no pruning):** Encrypt everything client-side, decrypt in TEE, send to LLM with no pruning. Preserves security but eliminates the entire value proposition (token savings). Rejected.
