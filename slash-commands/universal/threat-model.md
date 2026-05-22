---
name: threat-model
description: Produce a STRIDE + OWASP ASI 2026 threat model for a feature, API, or system component. Use whenever designing something that touches auth, data, agents, or external input. Output goes to docs/threat-models/.
---

# /threat-model

Invokes the `owasp-asi-threat-model` skill with the `STRIDE_ASI_TEMPLATE.md`
template. Asks the user to describe the system, the trust boundaries, and the
data classes. Produces `docs/threat-models/<feature>.md`.

Run as: `/threat-model <feature-name>`
