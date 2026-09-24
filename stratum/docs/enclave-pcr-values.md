# Nitro Enclave PCR values — publication pending

No CQ enclave has been built or released. There are no trusted PCR values to
publish, and this file is not an attestation verifier. The v0.7 client encryption
primitive is offline only; encrypted request forwarding remains disabled under
`specs/tee/client-encryption.md#req-3--preserve-the-enclave-boundary-at-integration`.

Do not send a session key or encrypted context on the basis of values copied
from an API response or this file alone. A client must verify the AWS Nitro
attestation document's COSE signature and certificate chain, its fresh
challenge nonce, its enclave public key, and the expected PCR measurements
before it wraps a session key to that public key. Reject missing fields,
mismatches, expired or untrusted certificates, and debug-mode documents with
zero PCRs. The project has no such verifier or published enclave endpoint yet.

## Release record template

For each built and independently reviewed enclave release, publish:

| Field | Value |
| --- | --- |
| Release version and date | Pending |
| Source commit and reviewed build procedure | Pending |
| EIF digest and reproducibility evidence | Pending |
| PCR0 (enclave image) | Pending |
| PCR1 (kernel and bootstrap) | Pending |
| PCR2 (application) | Pending |
| PCR3, PCR4, PCR8 policy, if bound | Pending |
| Attestation verifier version and negative-test proof | Pending |

Record exact values from `nitro-cli build-enclave` and verify that an
independent build from the same source produces the expected measurements.
Do not label a release reproducible until that comparison has passed. Pin
the accepted measurements in the client release before deploying the enclave;
retain a documented overlap window when rotating versions.

The enclave must terminate authenticated provider TLS through an opaque
parent relay and encrypt the provider response for the client. The parent
must not receive plaintext requests, context, keys, or provider responses.

AWS references: [attestation verification](https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html),
[PCR meanings and debug mode](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html),
and [enclave networking and vsock](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave-concepts.html).
