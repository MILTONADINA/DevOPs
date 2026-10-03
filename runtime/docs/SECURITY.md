# SECURITY.md — ZK-Context and TEE Architecture

**Status:** This is the target v0.7 architecture, not a current production
guarantee. Offline client encryption and RSA-OAEP key wrapping primitives are
implemented, but the proxy still supports plaintext requests. Verified enclave
attestation, matching key unwrapping, enclave decryption, and independent review
are release gates before encrypted request forwarding can be enabled.

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
| Usage corruption | Alter token counts or replay an event with different inputs | C2 keeps exact counts, trusted org/project and event-ID uniqueness; the writer verifies replay inputs. Rows are unsigned and mutable, with no cryptographic tamper-evidence claim. |

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

The offline client primitive uses HKDF-SHA256 with the fixed versioned salt
`cq-zk-context-hkdf-v1` and info `cq-session-<session-id>`. Each AES-256-GCM
message has a fresh 96-bit IV and authenticates
`cq-attestation-nonce-v1:<nonce>` as additional data. The nonce does not prove
attestation by itself; the client must verify AWS attestation and expected PCRs
before sending a key or encrypted payload (ADR-0022). The offline wrapper
accepts only DER SPKI RSA keys of at least 3072 bits and uses RSA-OAEP-SHA-256
with `cq-sek-wrap-v1:<nonce>` as its label. It does not authenticate the key.

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
  │                                │◀── opaque TLS frames ────────│
  │                                │──── relay TLS frames ────────▶ Anthropic API
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
func handleRequest(req EncryptedPayload) (EncryptedResponse, error) {
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

    // 4. Build the Anthropic API request inside the enclave
    apiReq := buildAPIRequest(plaintext, req.SessionMetadata)

    // 5. Terminate provider TLS inside the enclave via an opaque vsock relay.
    // The parent sees only TLS frames, never apiReq or TLS session keys.
    providerResp := sendProviderRequestOverEnclaveTLS(apiReq)
    return encryptResponseForClient(providerResp, sek), nil
}
```

Nitro enclaves have no external network interface; a vsock relay on the parent
provides transport. The enclave must validate the provider certificate and
hold the TLS session keys itself, then encrypt the provider response for the
client before returning it to the parent. This is an integration requirement,
not an implemented feature. Returning a plaintext request or response to the
parent would break the stated trust boundary.

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
| GDPR Article 17 (right to erasure) | Not verified | Initial managed explicit-session API proof exists; broader deletion coverage and a compliance/retention assessment remain open |
| HIPAA | Not supported in MVP | PHI requires BAA and additional controls |
| CCPA | Not verified | No complete deletion workflow or compliance assessment is recorded |

### GDPR Erasure

The initial managed explicit-session class passed controlled authenticated HTTP
erasure verification on 2026-10-03; this is not a general compliance claim or a
one-year/<30-second benchmark. C2/M1
makes `billing_records` unsigned and mutable; C4-A/M2 removes invoice
tables/RPCs and the financial preflight blocker. Usage remains ordinary
session-linked data with organization/session foreign keys. ADR-0021 is
superseded; `specs/memory/session-erasure.md` preserves the nonfinancial gates.

The organization-authenticated preflight reports scoped database counts,
including numeric `billing_records`, and separate managed-store classifications.
It is ready only for the enrolled class under trusted activation of a fresh
isolated source/process/store generation. Unknown stores, unsafe dependencies
or stale coverage block execution; protected reads/exports durably mark
organization-wide uncertainty before copying. The initial boundary excludes
explicit-session content from unsupported application memory/capture paths;
it does not prove deletion of arbitrary RAM, external copies or backups.
DELETE only ends a session; POST performs erasure and returns a stable scoped
receipt with retained metadata and declared exclusions.

The real API proof covers ordinary private-data deletion, shared/foreign-data
survival, rollback and retry after a lost response. Broader historical and
conversation-session coverage, general managed onboarding/restart operations
and the representative one-year benchmark remain open. Client-held responses,
privileged host/database snapshots and physical heap/OS remnants are excluded,
not claimed erased or anonymous. See the
[limited erasure runbook](../../docs/runbooks/LOCAL_STRATUM.md#limited-managed-erasure-candidate)
for the proof binding and operating restrictions.

Before an erasure can report success, the required workflow is:

1. Resolve the authenticated organization/session and inventory every row,
   graph reuse relationship, cache, external copy and backup; block on unknown
   ownership or incomplete coverage.
2. Prevent new writes and invalidate retained session memory without
   repersisting it through eviction callbacks.
3. Delete session-owned facts, ordinary usage, pruning logs and their
   source/vector/audit derivatives in one database transaction, preserving
   other tenants and graph data still shared by another session.
4. Verify all required stores; a failure must retain a retryable incomplete
   record and must not return success.
5. Return a timestamp and machine-checkable deleted/retained classes. Prove
   actual API deletion separately from the representative one-year benchmark.

The [European Commission explains](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/application-gdpr_en)
that pseudonymised data remains personal data if re-identification is possible;
replacing an ID with a salted hash must not be assumed to be anonymisation.
Any retention exception needs an applicable legal basis under
[GDPR Article 17(3)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679).

---

## Security Incident Response

If a security vulnerability is discovered:

1. Immediately rotate all enclave private keys (new enclave deployment)
2. Invalidate all active session keys (force re-attestation)
3. Audit billing logs for evidence of unauthorized access
4. Notify affected customers within 72 hours (GDPR requirement)
5. Publish a post-mortem within 30 days

Report security vulnerabilities through GitHub private vulnerability reporting: <https://github.com/MILTONADINA/DevOPs/security/advisories/new>. See `docs/SECURITY.md` at the repository root for the full policy.

Do not open public GitHub issues for security bugs.
