/**
 * Client-side encryption primitive — AES-256-GCM (Phase 4 / v0.7.x).
 *
 * Phase 4+: encrypts pruned context spans client-side before transmission to
 * the CQ proxy; the proxy only ever decrypts inside the AWS Nitro TEE boundary
 * (docs/SECURITY.md). Session key derived via HKDF-SHA256 from the customer's
 * master key.
 *
 * Offline primitive only. No request path calls it. Enclave attestation, key
 * wrapping, and enclave decryption remain separate release gates; a nonce
 * string alone does not prove attestation. See ADR-0022.
 *
 * SECURITY (binding when implemented, per stratum CLAUDE.md + docs/SECURITY.md):
 *   - AES-256-GCM only; per-session key via HKDF-SHA256 from the master key.
 *   - The caller MUST verify TEE attestation before transmitting a key or payload.
 *   - Never log decrypted context outside the TEE boundary.
 */

import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";

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

const HKDF_SALT = Buffer.from("cq-zk-context-hkdf-v1", "utf8");
const AAD_PREFIX = "cq-attestation-nonce-v1:";

/**
 * Derive a per-session AES-256 key from the customer master key via HKDF-SHA256.
 *
 * @param masterKey - the customer's 32-byte master key, held only on the client.
 * @param sessionId - the unique session id used as HKDF info context.
 * @returns the derived 256-bit session key.
 * @throws on invalid key or session identity.
 */
export async function deriveSessionKey(masterKey: Uint8Array, sessionId: string): Promise<Uint8Array> {
  if (masterKey.length !== 32) throw new Error("client encryption requires a 32-byte master key");
  if (sessionId.trim() === "") throw new Error("client encryption requires a nonempty session ID");
  return new Uint8Array(hkdfSync("sha256", masterKey, HKDF_SALT, Buffer.from(`cq-session-${sessionId}`, "utf8"), 32));
}

/**
 * Encrypt pruned context spans for transmission (AES-256-GCM).
 *
 * @param plaintext - the serialized pruned context.
 * @param sessionKey - the HKDF-derived 32-byte session key.
 * @param attestationNonce - opaque nonce from a separately verified TEE attestation.
 * @returns the {@link EncryptedPayload}.
 * @throws on invalid key or nonce.
 */
export async function encryptSpans(plaintext: string, sessionKey: Uint8Array, attestationNonce: string): Promise<EncryptedPayload> {
  if (sessionKey.length !== 32) throw new Error("client encryption requires a 32-byte session key");
  if (attestationNonce.trim() === "") throw new Error("client encryption requires a nonempty attestation nonce");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}${attestationNonce}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    auth_tag: Buffer.from(cipher.getAuthTag()).toString("base64"),
    attestation_nonce: attestationNonce,
  };
}
