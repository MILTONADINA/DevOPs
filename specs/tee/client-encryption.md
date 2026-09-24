# Client encryption primitive for the v0.7 enclave path

**Scope:** `plan.md` §6a and `stratum/docs/SECURITY.md` key hierarchy. This
primitive remains disconnected from request forwarding until verified enclave
attestation, matching key unwrapping, and decryption are implemented and reviewed.

## REQ-1 — Derive an isolated session key

WHEN given a 32-byte customer-held master key and a nonempty session ID, THE
CLIENT SHALL derive a 32-byte session key with HKDF-SHA256, a versioned fixed
domain salt, and `cq-session-<session-id>` as info. It SHALL reject other key
lengths and blank session IDs. The universal hook's `.workflow/state/session-key`
is for marker HMAC rotation and SHALL NOT be used as this master key.

## REQ-2 — Authenticated context encryption

WHEN given serialized context, a derived 32-byte session key, and an opaque
nonempty attestation nonce, THE CLIENT SHALL use AES-256-GCM with a fresh random
96-bit IV and a 128-bit tag. It SHALL bind the nonce as versioned additional
authenticated data (`cq-attestation-nonce-v1:<nonce>` in UTF-8) and return only
base64 IV, ciphertext, tag, and the nonce.
It SHALL reject invalid key/nonce inputs before encryption and SHALL NOT log
plaintext or keys. The caller SHALL transmit no key or payload until it has
verified the enclave attestation; this primitive does not perform verification.

## REQ-3 — Preserve the enclave boundary at integration

WHEN an enclave gateway is implemented, IT SHALL NOT return decrypted context,
a plaintext Anthropic request, or a plaintext provider response to the parent
process. The enclave SHALL terminate an authenticated provider TLS session
itself through a parent relay that sees only encrypted traffic, and SHALL
encrypt the provider response to the client before returning it through the
parent. Until this boundary, attestation, and key wrapping are verified,
encrypted request forwarding SHALL remain disabled.

## Acceptance criteria

- A published AES-256-GCM known-answer vector checks the local cryptographic
  primitive, and independently decrypted payloads verify the wrapper's IV,
  ciphertext, tag, and nonce binding.
- Repeated encryptions with the same inputs yield different IVs, and tampering
  with ciphertext, tag, or nonce causes authentication failure.
- HKDF output is stable for one session, separated across sessions and master
  keys, and agrees with an independent HKDF implementation.
- Invalid inputs fail before a payload is returned. Existing proxy behavior
  remains unchanged; enclave attestation and live TEE gates remain open.
