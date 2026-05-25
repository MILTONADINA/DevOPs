# SECURITY.md — ZK-Context and TEE Architecture

## Security Philosophy

CQ's core security promise is: **raw customer context never transits the network in plaintext, and CQ operators cannot read it even in principle.**

This is not a trust promise. It is a cryptographic guarantee enforced by hardware.

We call this architecture **ZK-Context** — not Zero-Knowledge in the formal cryptographic sense, but in the practical product sense: CQ has zero knowledge of your raw context because the architecture makes it technically impossible for us to obtain it.

---

## Threat Model

| Threat Actor | Attack Vector | Mitigation |
|---|---|---|
| CQ employee / insider | Direct DB access | Raw context never stored in CQ systems |
| Compromised CQ server | Memory dump / log exfiltration | Context only decrypted inside TEE enclave |
| Network MITM | Intercept proxy traffic | TLS + end-to-end encryption (double layer) |
| Compromised Supabase | DB dump | Tier 2 stores structured facts only, not raw context |
| Malicious Pinecone access | Vector lookup | Embeddings are not reversible to plaintext |
| Client device compromise | Local key extraction | Separate concern — client OS security |
| Fake enclave attack | Spoofed TEE endpoint | Attestation document verification required |
| Billing fraud | Inflate original token counts | Token counts signed at proxy ingress before decryption |

---

## Encryption Architecture

### Client-Side Key Hierarchy

```
Master Key (customer-held, never sent to CQ)
      │
      ▼ HKDF-SHA256 (info = "cq-session-" + session_id)
Session Encryption Key (SEK)
      │
      ▼ AES-256-GCM
Encrypted context spans → sent to CQ Proxy
```

**Master Key:** Stored on the client device only. Derived from the customer's credentials using Argon2id. CQ never sees this key.

**Session Encryption Key:** Derived per-session from the master key using HKDF. A new SEK is derived for each Claude Code session. Compromise of one session's SEK does not affect other sessions.

**AES-256-GCM:** Authenticated encryption — provides both confidentiality and integrity. The authentication tag ensures that even if the ciphertext is tampered with in transit, decryption will fail.

### What Gets Encrypted

Only the context spans selected by KadaneDial are encrypted and sent to the proxy. Metadata (token counts, session ID, timestamps) travels in plaintext — it contains no sensitive content.

```typescript
interface EncryptedPayload {
  session_id: string;          // plaintext — needed for routing
  original_token_count: number; // plaintext — needed for billing baseline
  pruned_token_count: number;   // plaintext — needed for billing delta
  iv: Uint8Array;               // 12-byte AES-GCM IV
  ciphertext: Uint8Array;       // encrypted context spans
  auth_tag: Uint8Array;         // AES-GCM authentication tag
  attestation_nonce: string;    // for TEE verification
}
```

---

## Trusted Execution Environment (TEE)

### Why AWS Nitro Enclaves

Nitro Enclaves are isolated compute environments running on EC2. They have:
- No persistent storage
- No network access (except through a secure local channel to the parent EC2 instance)
- No SSH access — not even for AWS employees
- Cryptographic attestation that proves the exact code running inside

This means: if our enclave is correctly configured, **no human — including CQ engineers — can extract plaintext context from it**.

### Attestation Flow

Before any session begins, the client verifies the enclave:

```
Client                          CQ Proxy                    Nitro Enclave
  │                                │                              │
  │──── GET /attestation/nonce ────▶│                              │
  │                                │──── request attestation ────▶│
  │                                │◀─── attestation document ────│
  │◀─── attestation document ──────│                              │
  │                                │                              │
  │  [Client verifies document]    │                              │
  │  - Check AWS certificate chain │                              │
  │  - Verify PCR measurements     │                              │
  │    match published values      │                              │
  │  - Extract enclave public key  │                              │
  │                                │                              │
  │  [Client derives SEK]          │                              │
  │  [Client encrypts SEK with     │                              │
  │   enclave public key]          │                              │
  │                                │                              │
  │──── Encrypted SEK + payload ──▶│                              │
  │                                │──── forward to enclave ─────▶│
  │                                │                     [Decrypt SEK]
  │                                │                     [Decrypt context]
  │                                │                     [Forward to API]
  │                                │◀─── plaintext API request ───│
  │                                │──── forward to Anthropic API ▶
```

### PCR Measurements

The Nitro attestation document contains Platform Configuration Register (PCR) measurements — cryptographic hashes of the enclave's boot image, OS, and application code.

CQ publishes the expected PCR values for each released enclave version. Client libraries verify that the measured PCRs match the published values before trusting the enclave.

**If PCR values don't match, the client refuses to send the session key. The session fails. No data is transmitted.**

This means customers can independently verify they are talking to the published CQ enclave code, not a modified version.

---

## Enclave Application

The enclave runs a minimal Go application (chosen for small binary size and fast start):

```go
// Pseudocode — actual implementation in rust/enclave/
func handleRequest(req EncryptedPayload) (APIRequest, error) {
    // 1. Verify the attestation is for this enclave
    if !verifyAttestation(req.AttestationNonce) {
        return nil, ErrInvalidAttestation
    }

    // 2. Decrypt the session key using the enclave's private key
    sek, err := decryptWithPrivateKey(req.EncryptedSEK)
    if err != nil {
        return nil, ErrKeyDecryption
    }

    // 3. Decrypt the context payload
    plaintext, err := aesGCMDecrypt(req.Ciphertext, sek, req.IV, req.AuthTag)
    if err != nil {
        return nil, ErrContextDecryption
    }

    // 4. Build the Anthropic API request
    apiReq := buildAPIRequest(plaintext, req.SessionMetadata)

    // 5. Return — plaintext stays in enclave memory only
    // It is never written to disk, logged, or sent to the parent instance
    return apiReq, nil
}
```

The enclave has no logging. Errors are returned as typed error codes only — no error messages that could leak context fragments.

---

## Data at Rest

| Store | What's stored | Encrypted? | Key holder |
|---|---|---|---|
| Client device (Tier 1) | Verbatim turns + embeddings | Yes (disk encryption) | Customer |
| Supabase (Tier 2) | Structured facts only | Yes (Supabase at-rest) | CQ (facts have no raw context) |
| Pinecone (Tier 3) | Embeddings + fact metadata | Yes (Pinecone at-rest) | CQ (embeddings not reversible) |
| Neo4j (Tier 3) | Entity graph | Yes (Neo4j at-rest) | CQ (structured relationships only) |
| CQ Proxy logs | Session metadata, token counts | Yes | CQ |

**Raw context never appears in any CQ-controlled store.** The Supabase, Pinecone, and Neo4j stores contain only derived facts and embeddings, neither of which reconstructs the original conversation.

---

## Compliance

| Standard | Status | Notes |
|---|---|---|
| SOC 2 Type II | Target: Month 12 | Architecture designed for compliance from day one |
| GDPR Article 17 (right to erasure) | Supported | Session data deletion cascade across all tiers |
| HIPAA | Not supported in MVP | PHI requires BAA and additional controls |
| CCPA | Supported | No sale of personal data; data minimization by design |

### GDPR Erasure

When a customer requests erasure of a session:

1. Tier 1: clear session from RAM immediately
2. Tier 2: DELETE from all fact tables WHERE session_id = ?
3. Tier 3: Delete from Pinecone by metadata filter; delete nodes from Neo4j
4. Billing records: anonymize session_id (replace with salted hash) — required for financial compliance
5. Return erasure confirmation with timestamp

---

## Security Incident Response

If a security vulnerability is discovered:

1. Immediately rotate all enclave private keys (new enclave deployment)
2. Invalidate all active session keys (force re-attestation)
3. Audit billing logs for evidence of unauthorized access
4. Notify affected customers within 72 hours (GDPR requirement)
5. Publish a post-mortem within 30 days

Report security vulnerabilities to: `security@startum.com`

Do not open public GitHub issues for security bugs.
