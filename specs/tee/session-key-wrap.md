# Offline session-key wrapping for the v0.7 enclave path

**Scope:** `plan.md` §6a, `specs/tee/client-encryption.md` REQ-3, and
`stratum/docs/SECURITY.md` client key hierarchy. AWS Nitro attestation can
carry a DER-encoded enclave public key, but no verifier or enclave exists in
this project yet. This spec covers an offline client primitive only.

## REQ-1 — Wrap to a supplied enclave key

WHEN given a 32-byte HKDF-derived session key, a nonempty attestation challenge
nonce, and a DER SPKI RSA public key, THE CLIENT SHALL encrypt the session key
with RSA-OAEP using SHA-256 for OAEP and MGF1. It SHALL bind the nonce as the
UTF-8 OAEP label `cq-sek-wrap-v1:<nonce>` and return only a versioned algorithm
identifier, base64 ciphertext, and the nonce. It SHALL use an RSA key of at
least 3072 bits and reject other key types, malformed DER, blank nonces, and
incorrect session-key lengths before returning a wrapped key.

## REQ-2 — Keep attestation outside this primitive

WHEN wrapping a key, THE CLIENT SHALL make no network request or filesystem
write and SHALL NOT claim the supplied public key is authenticated. The caller
SHALL first verify the AWS COSE signature, certificate chain, challenge nonce,
public key, and published PCR policy. Until that verifier, an enclave private
key/decryptor, and the opaque provider relay are implemented and reviewed,
the wrapped key SHALL NOT be sent through the request path.

## Acceptance criteria

- A generated 3072-bit RSA key yields a ciphertext that an independent
  RSA-OAEP-SHA-256 decryptor opens only with the exact label and private key.
- Rewrapping the same inputs produces different ciphertexts.
- A changed nonce, altered ciphertext, wrong private key, malformed/non-RSA/
  2048-bit public key, or invalid session key fails as specified.
- The existing client encryption tests and proxy behavior remain unchanged;
  no request-path call site is added.
