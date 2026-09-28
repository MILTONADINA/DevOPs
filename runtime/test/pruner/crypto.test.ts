import { createCipheriv, generateKeyPairSync, webcrypto } from "node:crypto";
import { describe, test, expect } from "vitest";
import { deriveSessionKey, encryptSpans, wrapSessionKey, type EncryptedPayload } from "../../src/pruner/crypto";

const MASTER = Uint8Array.from({ length: 32 }, (_, i) => i);
const NONCE = "verified-attestation-challenge";

async function decryptForTest(payload: EncryptedPayload, key: Uint8Array): Promise<string> {
  const imported = await webcrypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const ciphertextAndTag = Buffer.concat([Buffer.from(payload.ciphertext, "base64"), Buffer.from(payload.auth_tag, "base64")]);
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(payload.iv, "base64"), additionalData: Buffer.from(`cq-attestation-nonce-v1:${payload.attestation_nonce}`), tagLength: 128 },
    imported,
    ciphertextAndTag,
  );
  return Buffer.from(plaintext).toString("utf8");
}

describe("client encryption primitive", () => {
  test("AES-256-GCM runtime agrees with NIST's zero-key 96-bit-IV known answer", () => {
    const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(12), { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(Buffer.alloc(16)), cipher.final()]);
    expect(ciphertext.toString("hex")).toBe("cea7403d4d606b6e074ec5d3baf39d18");
    expect(cipher.getAuthTag().toString("hex")).toBe("d0d1c8a799996bf0265b98b5d48ab919");
  });

  test("HKDF agrees with WebCrypto and separates sessions and masters", async () => {
    const actual = await deriveSessionKey(MASTER, "session-a");
    const imported = await webcrypto.subtle.importKey("raw", MASTER, "HKDF", false, ["deriveBits"]);
    const expected = await webcrypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: Buffer.from("cq-zk-context-hkdf-v1"), info: Buffer.from("cq-session-session-a") }, imported, 256);
    expect(actual).toEqual(new Uint8Array(expected));
    expect(await deriveSessionKey(MASTER, "session-a")).toEqual(actual);
    expect(await deriveSessionKey(MASTER, "session-b")).not.toEqual(actual);
    expect(
      await deriveSessionKey(
        Uint8Array.from(MASTER, (byte) => byte ^ 1),
        "session-a",
      ),
    ).not.toEqual(actual);
  });

  test("encrypts with fresh IV and authenticates the attestation nonce", async () => {
    const key = await deriveSessionKey(MASTER, "session-a");
    const first = await encryptSpans("private context 🔒", key, NONCE);
    const second = await encryptSpans("private context 🔒", key, NONCE);
    expect(Buffer.from(first.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(first.auth_tag, "base64")).toHaveLength(16);
    expect(first.iv).not.toBe(second.iv);
    expect(first.attestation_nonce).toBe(NONCE);
    expect(await decryptForTest(first, key)).toBe("private context 🔒");
    await expect(decryptForTest({ ...first, attestation_nonce: "changed" }, key)).rejects.toThrow();
    await expect(decryptForTest({ ...first, auth_tag: Buffer.alloc(16).toString("base64") }, key)).rejects.toThrow();
    await expect(decryptForTest({ ...first, ciphertext: Buffer.alloc(18).toString("base64") }, key)).rejects.toThrow();
  });

  test("rejects invalid keys and blank binding inputs", async () => {
    await expect(deriveSessionKey(new Uint8Array(31), "session-a")).rejects.toThrow(/32-byte master key/);
    await expect(deriveSessionKey(MASTER, " ")).rejects.toThrow(/session ID/);
    await expect(encryptSpans("private", new Uint8Array(31), NONCE)).rejects.toThrow(/32-byte session key/);
    await expect(encryptSpans("private", MASTER, " ")).rejects.toThrow(/attestation nonce/);
  });
});

describe("offline enclave session-key wrapping", () => {
  const enclave = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicDer = enclave.publicKey.export({ format: "der", type: "spki" });

  test("WebCrypto opens only the attestation-nonce-bound RSA-OAEP-SHA-256 ciphertext", async () => {
    const key = await deriveSessionKey(MASTER, "session-a");
    const first = await wrapSessionKey(key, publicDer, NONCE);
    const second = await wrapSessionKey(key, publicDer, NONCE);
    expect(first.algorithm).toBe("RSA-OAEP-SHA256-v1");
    expect(first.attestation_nonce).toBe(NONCE);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(Buffer.from(first.ciphertext, "base64")).toHaveLength(384);

    const privateDer = enclave.privateKey.export({ format: "der", type: "pkcs8" });
    const privateKey = await webcrypto.subtle.importKey("pkcs8", privateDer, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
    const decrypt = (nonce: string, ciphertext = first.ciphertext) =>
      webcrypto.subtle.decrypt({ name: "RSA-OAEP", label: Buffer.from(`cq-sek-wrap-v1:${nonce}`) }, privateKey, Buffer.from(ciphertext, "base64"));
    expect(new Uint8Array(await decrypt(NONCE))).toEqual(key);
    await expect(decrypt("changed")).rejects.toThrow();
    await expect(decrypt(NONCE, Buffer.alloc(384).toString("base64"))).rejects.toThrow();
    const wrongPrivateDer = generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey.export({ format: "der", type: "pkcs8" });
    const wrongPrivateKey = await webcrypto.subtle.importKey("pkcs8", wrongPrivateDer, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
    await expect(webcrypto.subtle.decrypt({ name: "RSA-OAEP", label: Buffer.from(`cq-sek-wrap-v1:${NONCE}`) }, wrongPrivateKey, Buffer.from(first.ciphertext, "base64"))).rejects.toThrow();
  });

  test("rejects invalid key material and nonce before returning ciphertext", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" });
    const small = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" });
    await expect(wrapSessionKey(new Uint8Array(31), publicDer, NONCE)).rejects.toThrow(/32-byte session key/);
    await expect(wrapSessionKey(MASTER, publicDer, " ")).rejects.toThrow(/attestation nonce/);
    await expect(wrapSessionKey(MASTER, Buffer.from("invalid"), NONCE)).rejects.toThrow(/DER SPKI/);
    await expect(wrapSessionKey(MASTER, ec, NONCE)).rejects.toThrow(/RSA public key/);
    await expect(wrapSessionKey(MASTER, small, NONCE)).rejects.toThrow(/3072/);
  });
});
