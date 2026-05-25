# No-Renovate Fixture Project

Analyzer fixture for `specs/phase-2/H-renovate-template.md` REQ-H8 / AC-H8.1.

This project declares an upgradable manifest (`package.json` with at least one
dependency) but intentionally has **no** `renovate.json` and **no**
`.github/dependabot.yml`. That state is the trigger condition for REQ-H8's
recommendation rule, which surfaces `templates/renovate/renovate.json` in the
emitted profile's `recommended.next_steps` array.

The integration test that consumes this fixture lives at
`.workflow/proofs/_checks/req-H8-renovate-next-step.js` (local /
gitignored). It copies this fixture into a temporary directory, runs the
analyzer against it, and asserts the Renovate-template entry appears.

Counterpart fixture: `tests/fixtures/analyzer/pci-dss-project/` — also a
minimal project, but with a Stripe dependency that triggers PCI DSS scope
(used by REQ-A5 / AC-A5.1).
