/**
 * Client-Side Encryption — AES-256-GCM (Phase 4 / v0.7.x hook-points).
 *
 * Phase 4+: encrypts pruned context spans client-side before transmission to
 * the CQ proxy; the proxy only ever decrypts inside the AWS Nitro TEE boundary
 * (docs/SECURITY.md). Session key derived via HKDF-SHA256 from the customer's
 * master key.
 *
 * STATUS — INTERFACE STUB ONLY (plan §3b: "document the interface; don't
 * implement yet"). This is a typed forward-declaration so v0.4.x pruner code
 * has stable Phase-4 hook-points. The functions THROW (not return fake data):
 * shipping placeholder crypto that silently "works" would be a critical
 * security defect. Real implementation requires an ADR + security review and is
 * gated on the v0.7.x ZK-Context/TEE work (AWS Nitro hardware).
 *
 * SECURITY (binding when implemented, per stratum CLAUDE.md + docs/SECURITY.md):
 *   - AES-256-GCM only; per-session key via HKDF-SHA256 from the master key.
 *   - The TEE attestation document MUST be verified before any decryption.
 *   - Never log decrypted context outside the TEE boundary.
 */

/** Encrypted payload shape (mirrors src/types/proxy.ts EncryptedPayload). */
export interface EncryptedPayload {
  /** Base64 AES-GCM initialization vector (96-bit recommended). */
  iv: string;
  /** Base64 ciphertext. */
  ciphertext: string;
  /** Base64 GCM authentication tag. */
  auth_tag: string;
  /** Nonce binding the ciphertext to a verified TEE attestation. */
  attestation_nonce: string;
}

const NOT_IMPLEMENTED =
  "client-side encryption is a Phase 4 (v0.7.x) hook-point — interface only, " +
  "not implemented. Requires an ADR + security review + AWS Nitro TEE. " +
  "See docs/SECURITY.md. Refusing to return placeholder crypto.";

/**
 * Derive a per-session AES-256 key from the customer master key via HKDF-SHA256.
 *
 * @param _masterKey - the customer's master key bytes.
 * @param _sessionId - the session id used as HKDF info/salt context.
 * @returns the derived 256-bit session key.
 * @throws ALWAYS — Phase 4 interface stub (see file header).
 */
export function deriveSessionKey(_masterKey: Uint8Array, _sessionId: string): Promise<Uint8Array> {
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}

/**
 * Encrypt pruned context spans for transmission (AES-256-GCM).
 *
 * @param _plaintext - the serialized pruned context.
 * @param _sessionKey - the HKDF-derived session key.
 * @param _attestationNonce - nonce from the verified TEE attestation.
 * @returns the {@link EncryptedPayload}.
 * @throws ALWAYS — Phase 4 interface stub (see file header).
 */
export function encryptSpans(
  _plaintext: string,
  _sessionKey: Uint8Array,
  _attestationNonce: string,
): Promise<EncryptedPayload> {
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}
