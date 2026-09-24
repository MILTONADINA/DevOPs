# ADR-0022: Versioned client encryption primitive before TEE integration

Status: accepted for offline implementation; request-path activation is gated.

The v0.7 client primitive derives a 256-bit session key with HKDF-SHA256 from a
customer-held 256-bit master key. A fixed `cq-zk-context-hkdf-v1` salt separates
this use from other master-key uses; `cq-session-<session-id>` is HKDF info.
The caller must provide a unique session ID. The universal session-end hook's
marker-HMAC key is unrelated and cannot stand in for the customer master key.

Each encryption uses a random 96-bit GCM IV and 128-bit tag. The versioned
attestation nonce is GCM additional authenticated data as
`cq-attestation-nonce-v1:<nonce>` in UTF-8, so changing it causes
decryption failure. The nonce is an opaque challenge, not proof that the client
verified an enclave. The client must validate AWS attestation and PCRs and wrap
the session key to the attested enclave public key before sending anything.
Those steps and enclave decryption are separate release gates. This module
exports no decrypt operation and is not wired to the proxy.

The earlier gateway sketch returned a plaintext API request to the parent,
contradicting the enclave isolation claim. Integration must keep provider TLS
termination inside the enclave and use the parent only as an opaque vsock
network relay. The relay must not receive plaintext or TLS session keys;
provider responses must be encrypted for the client before leaving the enclave.

Security review focus: IV uniqueness under a session key; domain separation;
key and nonce input validation; authentication failure on tampering; no logging
or network writes; no inference that a nonce string itself proves attestation.

References: [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final),
[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869), and
[AWS Nitro Enclaves concepts](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave-concepts.html).
