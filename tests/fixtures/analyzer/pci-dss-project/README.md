# PCI DSS Fixture Project

Test fixture for `analyzer/scan.ts` acceptance criterion **AC-A5.1** (spec
`specs/phase-2/A-pentest-stack.md` REQ-A5).

This project declares a `stripe` dependency, which the analyzer's
`detectDomain()` step maps to `compliance: [PCI DSS]`. That compliance
classification is the trigger for REQ-A5's recommendation rule, which adds
`shannon`, `pentagi`, `lyrie`, and `pentest-ai` to
`recommended.mcp_servers` in the emitted `.workflow/profile.yml`.

The fixture is intentionally minimal — no source code, no live network
calls, no secrets. Just enough of a `package.json` for the analyzer to
classify the domain.

The integration test that consumes this fixture lives at
`.workflow/proofs/_checks/req-A5-pentest-stack-rec.js` (local /
gitignored). The test copies this fixture into a temporary directory, runs
the analyzer against it, and asserts the 4 tools appear in
`recommended.mcp_servers`.
