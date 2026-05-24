# enclave-pcr-values.md — Nitro Enclave Attestation Values

This file is the authoritative source of expected PCR (Platform Configuration Register) values for each published CQ enclave release.

Clients verify these values during TEE attestation before transmitting any session keys. If the measured PCR values from the enclave do not match the values published here, the client refuses to establish a ZK-Context session.

This file is public. It must be updated as part of every enclave release.

---

## How to Verify Manually

```bash
# 1. Request attestation document from the running enclave
curl -X POST https://proxy.startum.com/v1/attestation/nonce \
  -H "Authorization: Bearer <your-api-key>"
# Returns: { "nonce": "base64...", "attestation_document": "base64..." }

# 2. Decode and inspect the attestation document
# The document is a CBOR-encoded structure signed by AWS
# Use the nitro-cli or the cq-verify tool:
npx cq-verify attestation <attestation_document_base64>

# 3. Compare PCR0, PCR1, PCR2 against the values below for your enclave version
```

---

## Released Enclave Versions

### v0.1.0 — Initial Release

**Release date:** TBD
**Build commit:** TBD
**Built by:** TBD
**Reproducible build:** Yes — see `rust/enclave/BUILD.md` for instructions to reproduce

```
PCR0: <fill in after first enclave build>
PCR1: <fill in after first enclave build>
PCR2: <fill in after first enclave build>
```

**What this enclave does:**
- Accepts encrypted session payloads from CQ clients
- Verifies client attestation nonce
- Decrypts AES-256-GCM context using the client-provided session key
- Forwards decrypted context to the Anthropic API
- Returns the API response to the CQ proxy
- Does not log, store, or transmit plaintext context

**Changelog since previous version:** Initial release — no previous version.

---

## Process for Publishing New PCR Values

When a new enclave version is deployed:

1. Build the new enclave image on EC2:
   ```bash
   nitro-cli build-enclave --docker-uri cq-enclave:vX.Y.Z --output-file cq-enclave-vX.Y.Z.eif
   ```
   The build output includes PCR0, PCR1, PCR2. Record them exactly.

2. Verify the build is reproducible:
   ```bash
   # Build a second time from the same source
   nitro-cli build-enclave --docker-uri cq-enclave:vX.Y.Z --output-file cq-enclave-vX.Y.Z-verify.eif
   # Compare SHA256 of both .eif files — must match
   sha256sum cq-enclave-vX.Y.Z.eif cq-enclave-vX.Y.Z-verify.eif
   ```

3. Add a new section to this file with the version, date, build commit, and PCR values.

4. Commit and push — this file must be updated before deploying the new enclave.

5. Update the client library's expected PCR values and cut a new client release.

6. Run both old and new enclaves in parallel for at least 48 hours while clients update.

7. Announce the new enclave version in the changelog and notify enterprise customers.

---

## Security Notes

- PCR0 is a hash of the enclave image binary. Any code change produces a different PCR0.
- PCR1 is a hash of the Linux kernel and boot components used by the enclave.
- PCR2 is a hash of the application binary loaded into the enclave.
- All three must match for attestation to succeed.
- If you observe a PCR mismatch, do not transmit data. Contact `security@startum.com` immediately.
