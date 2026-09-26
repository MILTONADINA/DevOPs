# ADR-0025: Open source, local-first, no payment

**Date:** 2026-09-26
**Status:** Accepted (owner decision, 2026-09-26)
**Supersedes in part:** ADR-0018 (its commercial and billing parts), ADR-0003
(decryption inside an AWS Nitro Enclave), ADR-0022 (the planned TEE
integration)
**Removal requirements:** `specs/ops/payment-removal.md`

## Context

Until this decision the roadmap ended in a commercial product. v0.9 was a
billing schema (HMAC-signed `billing_records`, an append-only trigger, a 20%
fee calculator), v1.0 was "first real invoice sent and paid" through Stripe,
and v0.7 was ZK-Context: client-side encryption with decryption inside an AWS
Nitro Enclave on a server the project would host. Most of the billing code
exists today (`stratum/src/billing/`, the `/billing` and `/v1/billing/*`
routes, `POST /stripe/webhook`, the invoice tables).

On 2026-09-26 the owner decided:

- "i need this project as open source. no payment." Clarified: "i have no
  intent for getting commercializing this repo. of course when devops is
  finished and a random user is using it, it might need them to set up some
  thing that would need money maybe like jev."
- "we are also not deploying, a user simply points their ai to this repo, and
  it configures on their machine."
- Token and USD figures stay, as information only. There is no fee and no
  invoice.
- The billing four-eyes gate (`hooks/universal/pre-tool/deploy-gate.sh`) is
  authorized for retirement. A separate graph cycle does that work.

## Decision

1. **Open source, no payment.** DevOPs and Stratum are MIT-licensed
   (`LICENSE`, `NOTICE.md`, PR #199). Nobody pays the project or the owner.
   A user may pay third parties directly for services they choose to use,
   such as an LLM provider or TypeSafe's Jev. No feature may require a
   payment to the project.
2. **Local-first, no deployment.** The goal is that a user points their AI
   agent at this repository and the agent configures DevOPs and Stratum on the
   user's own machine (macOS, Linux or WSL2); this is the v1.0 ship gate and
   is not yet verified. The project runs no hosted service. The
   conversation history stays on the user's machine.
3. **Usage is measured, not billed.** Stratum keeps exact token counts and
   shows token and USD estimates as information. The usage ledger stops being
   a financial record: no HMAC signature, no fee column, no append-only
   enforcement, no invoice.
4. **v0.7 (ZK-Context + AWS Nitro TEE) is dropped.** The enclave existed to
   protect user context on a server the project would host. With no hosted
   server, the context never leaves the user's machine through the project,
   so the enclave, the attestation flow and the TEE gateway have nothing to
   protect. The offline AES-256-GCM primitive from ADR-0022
   (`stratum/src/pruner/crypto.ts`) stays in the tree as code; no work is
   planned on it.
5. **Deployment-topology gates become local measurements.** Latency and
   storage gates that waited for "a deployed topology" are measured on the
   user's machine against the local stack (ADR-0020's local Supabase-compatible
   Compose stack). This changes where a gate is measured, not whether it has
   passed.
6. **The roadmap is redefined.** v0.9 is payment removal plus self-hosted
   team features (organizations, API keys, usage estimates, session erasure).
   v1.0 is: a user points their AI at this repository and gets a working local
   setup on macOS, Linux and WSL2. `plan.md` §8 and §9 hold the checklists.
7. **Product direction.** The full history stays local. Jev (TypeSafe's
   System One judge model; its documentation lists only Jev 1.13.0) is an
   optional, measured judge over that history, used where a measurement shows
   it reduces tokens or drift. Any use of Jev on Stratum session data needs
   its own spec, threat-model entry and ADR first, because it sends content
   off the machine (`specs/graph/J-jev-judgments.md`, Out of scope). The
   graph-engineering pipeline is a full-lifecycle agile team that adapts to
   any software-engineering task, security included, and picks open-source or
   commercial tools per task.

### What this supersedes

- **ADR-0018**: the pilot framing (a dedicated instance for a paying design
  partner), the reseller analysis against the savings-arbitrage model, and
  the "partner contract" trigger for per-request key pass-through. The
  technical finding stands: in team mode every organization is forwarded on
  the single upstream key from the proxy's environment, and the CQ key is not
  forwarded.
- **ADR-0003**: decryption inside an AWS Nitro Enclave. Client-side (local)
  pruning stands.
- **ADR-0022**: the TEE integration the primitive was built for. The
  primitive's own design record stands as a description of the offline code.

### Related records this decision affects

- ADR-0005 chose Cloudflare Workers as the production runtime and ADR-0020
  left the production topology open. Under this decision there is no
  production deployment; their status lines are left for the cycles that
  touch that code.
- ADR-0021 (session erasure needs a financial retention boundary) loses its
  premise once the ledger is unsigned and the invoice tables are gone. It is
  superseded in cycle C4 of `specs/ops/payment-removal.md`, together with the
  erasure code change.

## Consequences

- The payment code is still in the tree when this ADR is accepted. Four
  graph cycles remove it (C1–C4 in `specs/ops/payment-removal.md`). Until
  then, documents that describe current code behavior (API reference,
  architecture, telemetry, webhooks, runbooks) keep describing it; each
  changes with the cycle that changes the code.
- The deletion of `stratum/src/billing/` touches a path under the billing
  four-eyes gate. That gate is retired by its own graph cycle before C3.
- The LLM gateway (`stratum/src/proxy/providers/`) is not payment code and is
  kept unchanged.
- Test floors fall as payment tests are removed. Each lowering is a new entry
  in the `lowerings` array of `governance/test-floors.json`, which the CI
  ratchet checks (specs/ops/payment-removal.md REQ-12), rather than hidden.
- Backups taken before the removal must still restore: retired tables and
  columns are skipped and reported, not refused.
- Hour totals in `plan.md` §11, `blueprint.md` §5 and
  `docs/LAUNCH_READINESS.md` were withdrawn: v0.7 is dropped and v0.9 and
  v1.0 were redefined without estimates.
- A user who enables a paid third-party service (an LLM provider, Jev) pays
  that provider directly and supplies their own key. The setup must work
  without Jev.

## Alternatives Considered

- **Keep billing as an optional, off-by-default module.** Rejected by the
  owner ("no payment"). Keeping it would also keep the Stripe, invoice and
  signing code, its tests and its four-eyes gate as maintenance cost for a
  feature no user needs.
- **Keep v0.7 for users who self-host on a shared server.** Rejected: the
  project does not deploy, and the enclave design assumes an operator who is
  not the user. A team that runs Stratum on its own server trusts its own
  operator.
