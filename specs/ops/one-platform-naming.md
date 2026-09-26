# One platform named DevOps

**Spec ID**: ops/one-platform-naming
**Status**: draft (the owner's directive is recorded; this spec's details go to spec batch 2)
**Last updated**: 2026-09-26
**Owner**: Milton Adina
**Decision context**: ADR-0026 (`stratum/docs/decisions/0026-one-platform-named-devops.md`). On 2026-09-26 the owner wrote: "stratum mand devops should not exixt as 2 different repos, this is one platform. it should all be merged and called devops" (verbatim, typos included; approvals.jsonl `owner_decision` "one platform named DevOps"). It supersedes quality-plan decision O-14, which had kept "Stratum" as a product name.

## Problem

The code is already in one repository. `stratum/` was added as a subtree (ed73c0d) from the only commit of the separate `MILTONADINA/Stratum` repository, and that repository is now archived with a pointer here. The platform still presents two names, though:

- "stratum" (any case) appears 1,892 times in 235 files, and "CQ" (Context Quotient) names most settings and headers.
- The code reads 18 settings named `CQ_*`, `STRATUM_*` or `DEVOPS_STRATUM_*`: 17 are mapped below, and `CQ_BILLING_SIGNING_SECRET` goes with the payment layer. One unpublished MCP config names three more (Out of scope).
- The package in `stratum/package.json` is named `startum`.
- The local containers are `devops-stratum-*`.
- A required CI check is named `stratum-test`, and a test-floor key is named `stratum`.

## Out of scope

- **Records.** CHANGELOG entries for released versions, ADRs, `specs/meta/`, dated audit reports and `.workflow/` records stay as written. They are history.
- **Payment settings.** `CQ_BILLING_SIGNING_SECRET` and the other payment settings are removed by `specs/ops/payment-removal.md` and get no new name.
- **The `@miltonadina/stratum-mcp` config.** `mcp-configs/universal/memory-stratum.json` and its `STRATUM_API_KEY`, `STRATUM_TENANT_ID` and `STRATUM_BASE_URL` are removed with the other unpublished MCP configs (quality plan O-10).

## Requirements

### REQ-1 (Ubiquitous): one name in user-facing text
THE SYSTEM SHALL name the platform "DevOps" in user-facing text: READMEs, current docs, CLI and log output, the OpenAPI title, dashboard titles and package descriptions. It SHALL name its parts by function: the DevOps proxy, DevOps memory, the pruner. "Stratum" and "CQ" SHALL appear in current text only in the deprecation table that REQ-3 requires and in paths that REQ-5 has not yet moved.

### REQ-2 (Ubiquitous): product-named settings move to the DEVOPS_ prefix
This requirement covers two kinds of setting:
- every setting whose name carries a legacy product prefix (`CQ_`, `STRATUM_` or `DEVOPS_STRATUM_`), plus the proxy's `HOST`;
- every setting added after this spec.

Each SHALL have a canonical name of the form `DEVOPS_<AREA>_<NAME>`:
- the runtime under `stratum/` uses the areas PROXY, MEMORY, PRUNER, AUDIT, TELEMETRY, LOCAL (the local stack and setup) and LOCAL_MODEL (a local model server), and `DEVOPS_TEAM_MODE` is its one setting with no area;
- the workflow under `scripts/` and `hooks/` keeps the areas its `DEVOPS_` settings already use: GRAPH, BUDGET, LOOP, SESSION, and `DEVOPS_ROOT`.

Other existing names keep their names:
- vendor-defined names (`ANTHROPIC_*`, `OPENAI_*`, `OPENROUTER_*`, `GEMINI_*`, `GOOGLE_API_KEY`, `SUPABASE_*`, `TYPESAFE_*`, `VERCEL`, `CLAUDE_PROJECT_DIR`, `HOME`, `PATH`, `PORT`, `NODE_ENV`);
- generic operational names (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW`, `LOG_LEVEL`);
- the graph pipeline's existing `GRAPH_*` names (a new graph setting uses `DEVOPS_GRAPH_`);
- the names local to one script or eval (for example `INGEST_ORG_ID`, `PROMOTE_ORG_ID`, `SMOKE_MODEL`, `SOURCE_SUBDIR`, `EVAL_FULL_PUBLISHED`, `LONGMEMEVAL_TYPES`).

One exception to the list: `GRAPH_PREFLIGHT_DEPS_STRATUM_DIR` is renamed together with the directory (REQ-5).

The mapping:

| Canonical name | Legacy alias |
|---|---|
| `DEVOPS_TEAM_MODE` | `CQ_COMMERCIAL` |
| `DEVOPS_LOCAL_MODEL_BASE_URL` | `CQ_LOCAL_BASE_URL` |
| `DEVOPS_LOCAL_MODEL_API_KEY` | `CQ_LOCAL_API_KEY` |
| `DEVOPS_MEMORY_EXTRACT_MODEL` | `CQ_MEMORY_EXTRACT_MODEL` |
| `DEVOPS_MEMORY_SOURCE_SUMMARY_MODEL` | `CQ_SOURCE_SUMMARY_MODEL` |
| `DEVOPS_MEMORY_PROJECT_ROOT` | `DEVOPS_STRATUM_PROJECT_ROOT` |
| `DEVOPS_MEMORY_ORG_ID` | `DEVOPS_STRATUM_ORG_ID` |
| `DEVOPS_MEMORY_PROJECT_SCOPE` | `DEVOPS_STRATUM_PROJECT_SCOPE` |
| `DEVOPS_AUDIT_REPO_ROOT` | `CQ_AUDIT_REPO_ROOT` |
| `DEVOPS_PROXY_SHADOW_OBSERVE` | `CQ_SHADOW_OBSERVE` |
| `DEVOPS_PROXY_USAGE_OUTBOX_DIR` | `CQ_USAGE_OUTBOX_DIR` |
| `DEVOPS_PROXY_UPSTREAM_TIMEOUT_MS` | `CQ_UPSTREAM_TIMEOUT_MS` |
| `DEVOPS_PROXY_UPSTREAM_IDLE_MS` | `CQ_UPSTREAM_IDLE_MS` |
| `DEVOPS_PROXY_DEFAULT_PROVIDER` | `CQ_DEFAULT_PROVIDER` |
| `DEVOPS_PROXY_CAPTURE_DIR` | `CQ_CAPTURE_DIR` |
| `DEVOPS_PROXY_INPUT_PRICE_PER_TOKEN_USD` | `CQ_INPUT_PRICE_PER_TOKEN` |
| `DEVOPS_TELEMETRY_OPT_OUT` | `STRATUM_TELEMETRY_OPT_OUT` |
| `DEVOPS_PROXY_HOST` | `HOST` (`specs/security/stratum-local-network.md` REQ-3) |

Specs that plan a setting not yet in code use the canonical form too. `specs/memory/tier2-long-history-recall.md` plans `CQ_RECALL_MODE`, which becomes `DEVOPS_PROXY_RECALL_MODE`. It has no alias, because it has never shipped.

The S1 settings `DEVOPS_PROXY_CORS_ORIGINS`, `DEVOPS_PROXY_ALLOWED_HOSTS`, `DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED` and `DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM` are new and have no alias.

### REQ-2b (Ubiquitous): product-named headers move to the x-devops- prefix
Every header with the legacy `x-cq-` or `x-stratum-` prefix, and every header the proxy defines after this spec, SHALL use the `x-devops-` prefix. Headers that follow a shared convention, such as `x-ratelimit-*`, keep their names.

| Canonical header | Legacy header | Direction and compatibility |
|---|---|---|
| `x-devops-conversation-id` | `x-cq-conversation-id` | both ways: clients send it, and the proxy returns it on responses. For one release the proxy accepts either on requests (the canonical header wins) and sends both on responses, with the same value. |
| `x-devops-signature` | `x-cq-signature` | sent by the proxy on outbound webhooks. For one release it sends both, so existing receivers keep verifying. |

### REQ-3 (Event-driven): legacy names keep working for one release
WHEN a setting is read, THE SYSTEM SHALL resolve it through one module that holds the table above:
- it SHALL read the canonical name first;
- if the canonical name is unset, it SHALL fall back to the legacy alias and log one warning per process, naming both;
- when both are set, the canonical name SHALL win, and the warning SHALL say the alias was ignored.

The aliases SHALL be removed in the release after the one that introduces them, and the CHANGELOG SHALL list them in that release's notes. Current docs SHALL name only canonical names, except for one deprecation table in the configuration docs.

### REQ-4 (Ubiquitous): local data survives every rename
Renaming the compose project, the containers or the directory SHALL NOT orphan an existing user's local database. Either:
- each stack SHALL keep the volume name it has today: the default stack's `devops-stratum-compose_db-data`, and an isolated instance's `devops-stratum-isolated-<instance>_db-data` (the `DEVOPS_LOCAL_INSTANCE` stacks in `stratum/scripts/local-compose.ts`). The name SHALL be declared through a per-stack variable, never as one fixed name, so an isolated instance can never mount the default stack's database; or
- `npm run setup` SHALL migrate each volume and leave the old one in place until the migration is verified.

The CI setup job SHALL check the volume by the name the compose file resolves.

### REQ-5 (Event-driven): the directory becomes runtime/
WHEN `stratum/` is renamed, it SHALL become `runtime/`, and its package SHALL be named `@miltonadina/devops-runtime`. The owner chose both on 2026-09-26 and asked for the move to be done (ADR-0026).

The move SHALL land right after the graph cycle that retires the billing four-eyes gate, whose path patterns still match `stratum/src/billing/`, and before the cycles that edit runtime paths: QW-1, QW-9, S1 and C1 to C4. Claims written to the current proof template re-run in a detached worktree at their `git_sha` and survive the move. Older claims go to the claim-retirement step planned after C4.

The move SHALL NOT rename the compose project, container or volume names (REQ-4 governs those), and SHALL NOT rename the settings (REQ-2 and REQ-3, in the naming cycle).

Checks keyed on the name SHALL be renamed in the same pull request, with branch protection updated in lockstep:
- the `stratum-test` required check;
- the `stratum` key in `governance/test-floors.json`;
- the `stratum` mode of `scripts/check-test-floor.mjs`.

The floor SHALL carry over by a declared rename that the ratchet accepts, never by a lowering.

### REQ-6 (Ubiquitous): no second repository
THE PROJECT SHALL keep exactly one repository for the platform. The owner asked on 2026-09-26 for `MILTONADINA/Stratum` to be deleted. Until the deletion is done it stays archived, with a description pointing to `MILTONADINA/DevOPs`. Any doc that points at the old repository as a live upstream SHALL say it is archived or deleted.

## Acceptance criteria

- **AC-1** (REQ-2, REQ-3). For each row of the table:
  - with only the canonical name set, the value is used and nothing is logged;
  - with only the alias set, the value is used and one warning names both;
  - with both set, the canonical value wins and the warning says the alias was ignored.
  **Verified by:** a unit test of the settings module, one case per row, whose titles name `specs/ops/one-platform-naming.md#AC-1`.
- **AC-1b** (REQ-2b). A request with only `x-cq-conversation-id` is grouped under that conversation. A request with both headers uses `x-devops-conversation-id`. During the alias release, every response that carries a conversation id carries both headers with the same value, so a client that reads only the legacy header continues its conversation. An outbound webhook carries both signature headers with the same value.
  **Verified by:** proxy route tests and a webhook signing test, whose titles name `specs/ops/one-platform-naming.md#AC-1b`.
- **AC-2** (REQ-2). A static check lists every `process.env` and `env` read under `stratum/src`, `stratum/scripts`, `scripts` and `hooks`.
  - It finds no `CQ_`, `STRATUM_` or `DEVOPS_STRATUM_` name outside the settings module (and `GRAPH_PREFLIGHT_DEPS_STRATUM_DIR` until REQ-5 lands).
  - Every name that is neither `DEVOPS_`-prefixed nor vendor-defined is listed, by exact name, in a committed baseline that may only shrink. The keep-list in REQ-2 describes what that baseline starts with. So a new setting outside the `DEVOPS_` prefix fails, including a new `GRAPH_` name.
  **Verified by:** a test that runs the check over the repository, plus negative controls with a planted `CQ_FOO` read and a planted new `FOO_BAR` read.
- **AC-3** (REQ-1). Outside the records that "Out of scope" names and the deprecation table, `git grep -niw "stratum\|startum"` over current docs, current specs and user-facing strings finds only paths not yet moved (REQ-5). Current specs include approved ones. Renaming the platform in a spec's prose, or a legacy setting or header name to its canonical name from the tables above, is a wording change that this spec's approval covers. The naming cycle records it in each changed spec's Amended line.
  **Verified by:** a test with an allowlist of the history paths, and a ratchet baseline that may only shrink until REQ-5 lands.
- **AC-4** (REQ-4). A user whose database volume `devops-stratum-compose_db-data` holds data runs the new `npm run setup` and finds their data served.
  **Verified by:** the CI setup job. It seeds a row, applies the renamed compose file, and reads the row back. `docker volume ls` shows no second, empty database volume. An isolated instance started with `DEVOPS_LOCAL_INSTANCE` and `DEVOPS_LOCAL_PORT` mounts its own volume, named `devops-stratum-isolated-<instance>_db-data` as before, not the default one.
- **AC-5** (REQ-5). After the move: `git ls-files stratum/` is empty; `runtime/package.json` is named `@miltonadina/devops-runtime`; branch protection requires the renamed check; and the ratchet accepts the renamed floor key while refusing a lower value under the new key.
  **Verified by:** the move PR's CI, and `gh api .../branches/main/protection` in its proof.
- **AC-6** (REQ-6). `gh api repos/MILTONADINA/Stratum` returns 404 (deleted). Until then, it reports `archived: true` with a description naming `MILTONADINA/DevOPs`.
  **Verified by:** a claim, checked by hand at each release.

## Falsified by

- A setting read under a `CQ_` or `STRATUM_` name anywhere outside the settings module after the rename lands, a new setting added outside the `DEVOPS_` prefix, or a proxy header with an `x-cq-` prefix after the alias release.
- A user's local memory database that is empty after `npm run setup` on a machine that had data, or an isolated instance that mounts the default stack's volume.
- A lowered floor, or a required check that is missing on main, after the move.
- User-facing text that calls the platform or a part of it "Stratum" after the rename lands, outside the allowlisted history.

## Order of work

1. Done (#206): ADR-0026, this spec, and the S1 spec amendment, so the new S1 settings are born `DEVOPS_PROXY_*`.
2. Done (#207): PR-2, the roadmap rewrite, uses "DevOps" for the platform in the READMEs it rewrites.
3. After the cycle that retires the billing four-eyes gate: the move cycle for REQ-5, `stratum/` to `runtime/` (owner decision).
4. The S1 cycle implements the S1 settings under their canonical names, on the moved paths.
5. After C4: a naming cycle for REQ-1 to REQ-4, which covers the settings module, the aliases, the docs and the compose volume.
