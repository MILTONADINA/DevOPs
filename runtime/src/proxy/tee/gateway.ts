/**
 * TEE Gateway — Routes encrypted payloads to AWS Nitro Enclave.
 *
 * Phase 4+: Receives encrypted context from the proxy,
 * forwards to the enclave. The enclave must keep plaintext and provider TLS
 * keys inside its boundary; the parent can only relay opaque encrypted traffic.
 */

// TODO: Implement TEE gateway (Phase 4)
