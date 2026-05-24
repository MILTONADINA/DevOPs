# BLUEPRINT.md — Startum Full System Architecture

## Purpose

This document is the authoritative design reference for Startum. Every implementation decision should trace back to a design principle stated here. When in doubt, re-read this document before writing code.

---

## Design Principles

1. **Determinism over vibes.** Every pruning and memory decision must be reproducible given the same inputs. No "the model decided" — the algorithm decides.
2. **Measurement before optimization.** We do not prune what we have not measured. Phase 0 and Phase 1 exist for this reason.
3. **Structured facts over lossy summaries.** We never ask an LLM to "summarize" history. We extract hard data points with defined schemas.
4. **Zero trust on context.** Raw context never transits the network in plaintext. It is encrypted client-side before transmission.
5. **Provable savings.** Every dollar we bill maps to a verifiable token delta with an audit trail.
6. **Eval gates everything.** No pruning change ships without running the eval suite and meeting accuracy thresholds.

---

## System Overview

```
┌────────────────────────────────────────────────────────────┐
│                     Client Environment                      │
│                                                            │
│  ┌───────────────┐    ┌──────────────────────────────┐    │
│  │  User Agent   │───▶│    CQ Client Library         │    │
│  │ (Claude Code) │    │  - ONNX local embedder       │    │
│  └───────────────┘    │  - KadaneDial pruner         │    │
│                       │  - AES-256-GCM encryptor     │    │
│                       └──────────────┬───────────────┘    │
└──────────────────────────────────────┼────────────────────┘
                                       │ Encrypted pruned spans
                                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   CQ Proxy (Cloudflare Edge)                 │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐  │
│  │ Token Meter │  │ TEE Gateway │  │  Memory Retriever │  │
│  │ (exact count│  │(AWS Nitro)  │  │  (T2/T3 lookup)   │  │
│  │  per call)  │  │(decrypt+fwd)│  │                   │  │
│  └──────┬──────┘  └──────┬──────┘  └────────┬──────────┘  │
│         └────────────────┼──────────────────┘             │
│                          │ Reconstructed plaintext context  │
│                          ▼                                  │
│                 ┌────────────────┐                          │
│                 │  Audit Check   │                          │
│                 │ (Git-attest)   │                          │
│                 └───────┬────────┘                          │
└─────────────────────────┼───────────────────────────────────┘
                          │ Verified context
                          ▼
                  ┌───────────────┐
                  │ LLM API       │
                  │ (Anthropic /  │
                  │  OpenAI)      │
                  └───────┬───────┘
                          │ Response
                          ▼
            ┌─────────────────────────┐
            │  Billing Engine         │
            │  delta = orig - pruned  │
            │  revenue = 0.20 × delta │
            └─────────────────────────┘
```

---

## Component Deep Dives

### 1. CQ Client Library

**Location:** `src/pruner/`

**Responsibilities:**
- Maintain a local rolling window of session turns (Tier 1, last 2 hours)
- On each new user turn, compute embeddings using the local ONNX model
- Run CQ-Extended KadaneDial to select relevant spans
- Encrypt selected spans with AES-256-GCM using the session key
- Transmit encrypted payload to the CQ Proxy

**Key constraint:** The ONNX model must run in under 10ms on a mid-range developer laptop. Profile every model change against this threshold.

**The local model:** A bi-encoder (e.g., `all-MiniLM-L6-v2` or equivalent, quantized to INT8 via ONNX export). The model runs entirely client-side and never sees the network. It produces 384-dimensional embeddings per dialogue turn.

---

### 2. CQ Proxy — Cloudflare Workers

**Location:** `src/proxy/`

**Responsibilities:**
- Receive encrypted context payloads from the client library
- Route to TEE Gateway for decryption
- Query Tier 2 and Tier 3 memory for relevant structured facts to inject
- Pass verified context to the Audit Check
- Forward to LLM API
- Record token counts (original and quarantined) for billing

**Why Cloudflare Workers:** Sub-50ms edge latency globally. Durable Objects provide stateful session management without cold starts.

**Worker limits to respect:**
- 128MB memory per Worker — heavy compute routes to Durable Objects or external endpoints
- CPU time: use streaming responses to avoid timeout on long LLM calls
- No blocking I/O — all storage calls are async

---

### 3. TEE Gateway — AWS Nitro Enclaves

**Location:** `src/proxy/tee/`

**Responsibilities:**
- Receive encrypted context from the proxy
- Verify the client's attestation token before decryption
- Decrypt inside the enclave — plaintext never leaves the enclave boundary
- Return decrypted context directly to the proxy's secure memory space

**Attestation flow:**
1. Client requests an attestation nonce from the enclave
2. Enclave returns a signed Nitro attestation document (PCR measurements)
3. Client verifies the document against AWS's certificate chain
4. Client derives the session encryption key and sends it encrypted to the enclave's public key
5. All future decryption for this session happens inside the enclave

If attestation verification fails, the session is rejected. No exceptions.

---

### 4. Memory Tiers

Full detail in `docs/MEMORY_ARCHITECTURE.md`. Summary:

| Tier | Storage | Retention | Format | Use |
|---|---|---|---|---|
| T1 Hot | Process RAM | 2 hours | Verbatim turns | Immediate context |
| T2 Warm | Supabase (Postgres) | 30 days | Structured facts | Decision history |
| T3 Cold | Pinecone + Neo4j | 1 year+ | Vector + graph | Deep retrieval |

---

### 5. Audit Engine

**Location:** `src/audit/`

**Responsibilities:**
- Before any memory claim reaches the LLM, verify it against the source of truth
- Three-tier escalation: Git-attestation → Llama 4 spot-check → Opus escalation

**Git-Attestation:** For every code-related memory claim, look up the corresponding commit hash in the Neo4j graph. If the claim conflicts with the indexed commit state, return `CONFLICT` and suppress the memory.

**Escalation logic:**
```
if claim.type == "code_change":
    result = git_attest(claim)          # $0 cost
    if result == CONFLICT: suppress()
    if result == UNVERIFIED:
        score = llama_spotcheck(claim)  # cheap
        if score < 0.85:
            result = opus_audit(claim)  # expensive, rare
```

---

### 6. Billing Engine

**Location:** `src/billing/`

**The core calculation:**
```
original_tokens  = count(raw_context_before_pruning)
quarantined_tokens = count(pruned_context_sent_to_api)
token_delta      = original_tokens - quarantined_tokens
cost_delta       = token_delta × (api_price_per_token)
cq_fee           = cost_delta × 0.20
```

Every invoice line item must link to:
- The session ID
- The original token count (logged before pruning)
- The quarantined token count (logged after pruning)
- The pruning log (which turns were removed, and their relevance scores)

This audit trail is non-negotiable. It is how we prove savings to CFOs and defend disputes.

---

## Data Flow: Full Request Lifecycle

```
1. User types a message in Claude Code
2. CQ Client intercepts the request
3. Client computes embeddings for the new turn (ONNX, <10ms)
4. Client runs KadaneDial over session history → selects relevant spans
5. Client logs original token count (for billing baseline)
6. Client encrypts selected spans (AES-256-GCM)
7. Client sends encrypted payload + session metadata to CQ Proxy
8. Proxy routes to TEE Gateway
9. TEE verifies attestation, decrypts spans
10. Proxy queries T2/T3 memory for relevant structured facts
11. Proxy assembles reconstructed context (pruned turns + injected facts)
12. Proxy sends context to Audit Engine
13. Audit Engine runs Git-attestation on code-related claims
14. If conflicts found: suppressed claims are flagged and logged
15. Proxy forwards verified context to Anthropic API
16. Anthropic returns response
17. Proxy returns response to client
18. Billing Engine records delta (original vs quarantined tokens)
19. Memory Engine extracts structured facts from the exchange (async)
20. Facts written to T2 and T3 stores (async, not on critical path)
```

---

## Security Threat Model

| Threat | Mitigation |
|---|---|
| CQ operator reads customer context | TEE attestation — decryption only inside verified enclave |
| Man-in-the-middle on proxy network | TLS + encrypted payload (double encryption) |
| Compromised Supabase | Tier 2 stores structured facts only, never raw context |
| Memory hallucination | Git-attestation rejects conflicting claims |
| Billing fraud | Immutable token count log signed at proxy ingress |
| Model audit leaks | Audit samples sent as single-turn calls, no history |

---

## Key Invariants

These must hold at all times. Any code change that would violate these requires an ADR and explicit sign-off:

1. Raw unencrypted context never persists outside the client device or TEE boundary.
2. LLM summarization is never used to compress memory. Structured extraction only.
3. Every billed token delta has a corresponding signed audit log entry.
4. Every code-related memory claim that reaches the LLM has been Git-attested or flagged UNVERIFIED.
5. The eval suite must pass (< 5% degradation on Faithfulness and Answer Relevancy) before any pruning change ships.
