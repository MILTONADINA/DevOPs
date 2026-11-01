# Changelog

All notable changes to DevOPs are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Fixed

- The `sprint-cycle.js` reviewer gate no longer passes when Build produced no change: an empty
  changed-file list (or one with only blank entries: whitespace, zero-width characters, dots and slashes) is INDETERMINATE and not ready, because there was
  nothing to review. No plan field can declare a no-change task. A resumed cycle on a clean tree now
  reads INDETERMINATE by design (REQ-M1, AC-M1.3). A lister entry that is not a string is INDETERMINATE too.

### Security

- The Semgrep job now downloads the pinned `semgrep-rules` commit as one tarball from `codeload.github.com`
  instead of about 711 unauthenticated requests to `raw.githubusercontent.com`, so a 429 burst can no longer fail
  the required check; 429 and 5xx answers are retried with exponential backoff. Only the pinned paths are
  extracted and each is still checked against its sha256; the run fails closed on a digest mismatch, a missing
  file, an unpinned file, a corrupt archive or any unsafe tar entry (traversal, absolute or backslash path, link,
  device, foreign top-level directory). `.workflow/network-allowlist.txt` swaps `raw.githubusercontent.com` for
  `codeload.github.com`. `docs/SECURITY.md` now documents reconciling the file list when moving the pin
  (`specs/security/ci-semgrep-scan.md` REQ-6, REQ-7, AC-6). Closes #327.
- `mcp-configs/universal/playwright.json` now pins `@playwright/mcp@0.0.83` and its baseline entry is removed. `@miltonadina/lyrie-mcp`, `stratum-mcp`, `pentagi-mcp`, `pentest-ai-mcp` and `shannon-mcp` are not published on npm (E404), so they stay baselined until published or removed (quality plan O-10). A test now locks the baseline to the scan's unpinned findings. Closes #322.
- Webhook delivery now resolves the customer hostname once, refuses it if any returned address is not public (numeric
  check, including IPv4-mapped, NAT64, 6to4, Teredo and CGNAT), and connects to the vetted address with Host and TLS name
  unchanged, closing the documented DNS-rebinding gap. Redirects are never followed. Retries are bounded and jittered,
  honour a clamped `Retry-After`, and skip 4xx; an undelivered event leaves a body-free local dead-letter record
  (`specs/security/webhook-egress.md`). BREAKING (runtime-internal): `createDefaultWebhookRetrier` now takes
  `(transport?, onUndelivered?, lookup?, onError?)` instead of `(doFetch?, onUndelivered?)`, and `DeliveryFetch` is
  removed; the package is private and nothing else called it. `scripts/check-enforcement.mjs` now reports
  mechanical=122 for its five REQs. When a hostname has several public addresses, delivery now tries each in turn
  (IPv6 and IPv4 alternating) after a refused, unreachable or timed-out connect, so an unreachable first address no
  longer fails the delivery; it never retries another address once connected or after a response.
- A new `agent-config` job in `security-scan.yml` runs `scripts/check-agent-config.mjs` on every pull
  request. It fails on a broad permission or `bypassPermissions` in `.claude/settings.json`, an
  unpinned MCP server under `mcp-configs/`, or a hook that does not run a file under `hooks/`, unless
  `governance/agent-config-baseline.json` names the finding (`specs/security/ci-agent-config-scan.md`).
  `scripts/check-enforcement.mjs` now reports mechanical=115 (was 112 above) for its three REQs.
- New pre-tool hook `hooks/universal/pre-tool/block-new-dependency.sh` blocks agent-run installs of
  packages the project has not declared (npm/pnpm/yarn/bun, pip/uv/poetry, `cargo add`) and asks for owner
  approval, with no network call. Plain `npm install` and `npm ci` stay allowed. It runs as a Bash pre-tool hook in
  `.claude/settings.json` (REQ-M30).
- The Semgrep job downloads its rules in a separate step from the `semgrep/semgrep-rules` repository at
  one pinned full commit SHA (711 files, 725 rules, covering the former owasp-top-ten,
  r2c-security-audit and secrets packs), checks each file's sha256 against
  `governance/semgrep-rules.sha256.json` (fails on a mismatch, a missing digest, a missing file or an
  unpinned file), then scans with `--network none` against those local files. The registry packs it
  used before were regenerated upstream, so their digest drifted and the required check went red; a
  commit does not change. Rule files are not committed (Semgrep Rules License).
  `node scripts/semgrep-rules.mjs refresh [PINS [COMMIT]]` updates the digests, or moves the pin to
  another commit, by hand. Three `nosemgrep` annotations now name the rule ids as the repository
  builds them (`direct-response-write`, `unknown-value-with-script-tag`).
  `scripts/check-enforcement.mjs` now reports mechanical=117 (was 115 above) for REQ-6 and REQ-7.

### Changed

- The sprint-cycle reviewer must return `filesSeen`; the workflow compares it with its own
  `git diff --name-only` list and sets the outcome INDETERMINATE (not ready) on any missing,
  unknown or absent file (REQ-M1, AC-M1.3).

### Documentation

- `docs/STATE.md` lists every persisted file with its owner, `schema_version`, readers and
  compatibility rule, plus a backup and restore drill. `tests/docs/state-doc.test.mjs` fails
  when a file with a `schema_version` field is not named there.

### Internal

- REQ-M8, M9, M10, M14 and M21 are split into a mechanical half (same id, now cites its tests in
  `Enforced by:`) and a twin for the rest (REQ-M32..M36, appended). The twins are `UNENFORCED`, not
  `PROCESS`, because each moves behaviour no code implements yet (launch spec binding, RED replay,
  evidence-backed completion states, red-team skip, freshness hook).
  `scripts/check-enforcement.mjs` reports mechanical=112 (was 107) and unenforced=19 (unchanged);
  `governance/enforcement-baseline.json` lists the five, and the root test floor rises to 1495.
- `tests/graph-dashboard/events-sse.test.mjs` waits for the new run to be active under an explicit 6s
  deadline instead of asserting on the first frame that lists it, which could see the journal while
  it was still empty (#300).
- REQ-HSB-1 moves from UNENFORCED to mechanically enforced via
  `tests/ci/gitleaksignore-baseline.test.mjs`; `scripts/check-enforcement.mjs` reports
  unenforced=24 (was 25) and `governance/enforcement-baseline.json` ratchets it. Added
  `tests/graph-resilience/req-contracts.test.mjs` for the checkable clauses of REQ-R4, R7, R9,
  R10 and M7, which stay UNENFORCED because each also has procedural clauses.
- REQ-R4, R7, R9, R10 and M7 are split into a mechanical half (same id, now cites its tests in
  `Enforced by:`) and a procedural half (REQ-R17, R18, R19, R20 and M31, `PROCESS`).
  `scripts/check-enforcement.mjs` reports mechanical=107 (was 102) and unenforced=19 (was 24);
  `governance/enforcement-baseline.json` lists the five, and the root test floor rises to 1471.
  `tests/graph-resilience/split-req-enforcement.test.mjs` pins the split.

### Fixed

- `scripts/pack-twice.mjs` stops its running `npm pack` step, removes its temporary
  directory and exits 130 (SIGINT) or 143 (SIGTERM) when interrupted
  (`specs/ops/script-entrypoints.md` REQ-4).

### Added

- Runtime tests for warm-to-cold promotion (`runtime/test/memory/promote-scope.test.ts`, 18 tests): org,
  session and project scope reach every graph write (an explicit null scope is passed through, not dropped),
  per-fact entity id resolution, content-free vector records, a missing embedding dropping only its own fact,
  and the `promoteFacts` orchestrator's gating. `memory/promote.ts` branch coverage rises from 57% to 95%.
- Runtime tests for the OpenAI-compatible provider transport's streaming and error paths
  (`runtime/test/proxy/openai-provider-stream.test.ts`, 19 tests): `extraHeaders` merging, 401/403 bodies never
  echoed (they can embed a key fragment), error-body fallbacks, SSE re-emit across chunk splits, mid-stream
  failure closing, and idle-timer abort and cleanup. `providers/openai.ts` line coverage rises from 29% to 96%.
- Runtime unit tests for the Supabase message-memory recorder
  (`runtime/test/proxy/message-memory-recorder.test.ts`, 22 tests): identity and project-scope validation
  fails closed before any write, the legacy session insert is checked, and audited facts are stored
  suppressed and released only when not a CONFLICT, by id, org and session. `message-memory.ts` line
  coverage rises from 10% to 100%.
- Runtime tests for the Gemini provider transport (`runtime/test/proxy/gemini-provider.test.ts`, 18 tests):
  URL and `x-goog-api-key` construction, error translation that never forwards 401/403 detail, the streaming
  error-body paths, SSE re-emit across chunk boundaries, mid-stream failure closing, and idle-timer abort and
  cleanup. `providers/gemini.ts` line coverage rises from 2% to 96%.
- The sprint cycle stops before Build (`SPEC_GATE_BLOCK:`) when the backlog item's spec holds
  `[NEEDS CLARIFICATION]` or an acceptance criterion is covered by no planned task; the planner
  schema gains `covers`, `criteria` and `clarification_markers`, and
  `scripts/lint-spec-status.mjs --item <spec>` checks the marker.
- The required `runtime-test` job measures V8 line coverage of `runtime/` (`npm run test:coverage`)
  and fails below the floor in `governance/coverage-floor.json`, checked by
  `scripts/check-coverage-floor.mjs` (`specs/ops/ci-product-suites.md` REQ-5).

## [0.5.1] — 2026-10-26
### Documentation

- `docs/OBSERVABILITY.md` lists the proxy's structured log levels, the fields each
  line carries, what is redacted and by which function, and how to read the lines;
  `tests/observability-log-fields-doc.test.mjs` checks each field against the source.

### Added

- The npm release workflow attaches a CycloneDX SBOM of the runtime dependencies
  (`npm sbom --omit dev`) to the GitHub release and the workflow run
  (`docs/RELEASING.md`).
### Security

- Lockfile updates (`npm audit fix`, no major bumps) clear the fast-uri advisories at the root
  and the vite and vitest-tooling advisories in `runtime/`.
- `runtime/` moves from zod 3 to zod ^4.6.7 (GHSA-mrhx-c7xc-m3w5), with length caps on the
  erasure RPC reason arrays and the activation manifest, and pins the dev-only wrangler
  chain's undici to ^7.30.1 through `overrides`. `npm audit --audit-level=high` now passes in
  the root and `runtime/` (`specs/security/ci-dependency-audit.md` AC-6).
### Documentation

- `docs/RELEASING.md` has a Support and end-of-life section (latest minor supported,
  previous minor security-only for 90 days, Node floor changes only in a minor with a
  CHANGELOG note), linked from `SECURITY.md` (`specs/release/npm-package.md` REQ-12).
### Internal

- A test reads the README Quick start commands and checks each against `package.json` and
  the CLI's `help`, so a renamed command or flag fails CI (`specs/release/npm-package.md` AC-15).
- `scripts/pack-twice.mjs` packs the package twice into separate temp dirs and fails,
  naming the differing entries, when the tarball sha256 or any file differs. CI's
  `package-smoke` job and the release workflow's `verify` job run it
  (`specs/release/npm-package.md` REQ-12).

### Fixed

- Long-running scripts (DAST control server, graph dashboard, runtime proxy, capture
  proxy) log one line, close their server and exit non-zero on an unhandled rejection or
  exception instead of staying half-alive (`specs/ops/script-entrypoints.md` REQ-3).
### Fixed

- Scripts started through a symlinked path no longer silently do nothing: every entry
  check uses the shared `scripts/lib/is-main.mjs`, which compares real paths
  (`specs/ops/script-entrypoints.md`, #293).
- `docs/UPGRADING.md`: how to move from 0.4.0 to 0.5.0 and onto the unreleased
  changes on `dev`, with the commands and what a consumer must change. The
  README links to it.

### Changed

- CI retries registry and network hiccups: every workflow that runs npm sets
  `npm_config_fetch_retries`/`fetch_retry_mintimeout`/`fetch_retry_maxtimeout`, the Semgrep
  image pull retries three times with backoff, and `tests/ci/workflow-install-retry.test.mjs`
  holds both.
- `devops init` links `@agile-graph/engine` 0.1.2 and 0.2.0 as well as 0.1.0 and
  0.1.1: their cloud-default tool definitions match the shipped pins exactly
  (`specs/graph/agile-graph-link.md` REQ-1).
- Dependabot configuration for npm and GitHub Actions, with weekly pull
  requests to `dev`: GitHub Actions updates grouped, npm minor and patch updates
  grouped for `/` and `/runtime`, npm majors separate.
- The reviewer subagent adds regression-across-specs and privacy-parity checks,
  per-branch spec and test checks, a trace-primitive-neutral observability check,
  unconsumed paid calls under cost, evidence for a Blocker and a per-check
  "Not applicable" verdict. The security subagent adds an offline mode, a
  language-model checklist, flag injection and host-project evidence
  (`specs/security/subagent-definitions.md`, #269).

### Security

- The dashboard pages (`/dashboard`, `/dashboard/graph`) allow their inline script
  by a per-response CSP nonce instead of `script-src 'unsafe-inline'`, and the HTML
  is sent with `Cache-Control: no-store`
  (`specs/memory/graph-dashboard.md` REQ-3).

## [0.5.0] — 2026-10-18

### Changed

- The local stack's three images are pinned by digest and pulled from
  `mirror.gcr.io`, with the same content public.ecr.aws serves: ECR Public's
  anonymous quota kept failing CI setup (`specs/ops/ci-product-suites.md` REQ-4).

### Security

- The graph command classifier separates words only on space, tab and newline, as
  the shell does, and refuses any other Unicode whitespace or format character
  outside quotes. Before, a non-breaking space before `#` made the hook read the
  rest of a command as a comment and allow it, while the shell ran it
  (GHSA-c3g3-xw48-qrp3, `specs/graph/M-masterpiece-standard.md` AC-M16.9).
- `npm run setup` installs runtime dependencies with `npm ci --ignore-scripts`, so dependency install scripts no longer run on first setup; an explicit `npm rebuild` allowlist (empty today) covers any package that needs one.

### Added — security policy

- `SECURITY.md`: supported versions (latest 0.x minor), supported Node range,
  private reporting through GitHub private vulnerability reporting, scope, and
  how to verify release provenance with `npm audit signatures`.

### Added — the optional Agile Graph link (specs/graph/agile-graph-link.md)

- `@agile-graph/engine` is an optional peer (`>=0.1.0`, so `npm install` never
  refuses). `ENGINE_VERSIONS` in `analyzer/agile-graph.js` lists the versions
  whose tools `mcp-configs/universal/agile-graph.tool-hashes.json` pins: 0.1.0
  and 0.1.1, which have identical tool definitions.
- When that engine is installed and Node is 24 to 26, `devops init` adds an
  `agile-graph` server to the project's `.mcp.json` and copies the pins to
  `.claude/agile-graph-tool-hashes.json`.
  - It finds the engine in the project, in a workspace root above it, next to
    a global DevOps, or on `PATH`.
  - The server uses cloud client mode, the pinned tool definitions, no run
    tools and `GRAPH_ENGINE_NO_FEEDBACK=1`.
  - It never replaces an existing entry or a `.mcp.json` it cannot read or
    write, and nothing in it can fail `devops init`.
  - `--no-agile-graph` skips the link. Without the engine, `devops init`
    prints one line.
- This repository's `/sprint` can run a person-driven cycle through the
  engine's CLI. The halt check, the preflight and the deploy gate stay in
  front of it.
- CI's new `agile-graph-link` job installs the packed DevOps with each listed
  engine version on Node 24. It checks that the shipped pins match the engine,
  then starts the exact server `devops init` registers.
- A weekly workflow, `agile-graph-versions.yml` (#266, REQ-8), checks the
  newest published engine. If `ENGINE_VERSIONS` does not list it, the workflow
  installs it with install scripts off and compares its tools with the pins.
  It then opens or updates one issue saying whether they match and which tools
  changed. It opens no branch and accepts nothing by itself.

### Changed

- On 2026-10-11 the commit history was rewritten to remove Claude attribution
  lines (Co-Authored-By, Claude-Session and "Generated with Claude Code") from
  93 commit messages. No file content changed, but every commit from the first
  such commit onward has a new ID.
  - The old history stays reachable at the tag `archive/pre-attribution-rewrite`.
  - `governance/changelog/2026-10-11-attribution-rewrite-commit-map.txt` maps
    each old commit ID to its new one.
  - The tags `v0.3.0` and `v0.4.0` move to the new commits; `v0.2.0` stays on
    the old history.
  - The committed claim `claim-2026-10-03-019` now names commit `0737952`
    (formerly `daa1250`), which has the same tree.

### Fixed

- `devops analyze` reads at most 2,000 directory entries when it looks for webhook
  handlers, stops at the first indicator and skips symbolic links, so a very large
  repository no longer makes it slow or exhaust memory.
- `devops init` installs a short consumer `CLAUDE.md` (from
  `templates/claude-md/CLAUDE_TEMPLATE.md`) instead of this repository's own
  development `CLAUDE.md`, which named files a project does not have (#284,
  `specs/release/npm-package.md` REQ-11). The package no longer ships the
  repository's `CLAUDE.md`. An existing `CLAUDE.md` is never replaced, and init
  now says so.
- `devops init` points the installed `AGENTS.md`, and the first steps it prints, at
  the constitution files where the package is installed, instead of at
  `constitution/` files a project does not have (#282,
  `specs/release/npm-package.md` REQ-10). Nothing is copied: the package stays a
  live dependency. Init adds `AGENTS.override.md` to `.gitignore` once, keeping
  existing content and line endings, and says to create `specs/`.
- `devops-analyze --help` and `-h` print usage and exit without writing any file;
  an unknown flag exits 2 before any scan, also next to `--help` (#281,
  `specs/release/npm-package.md` REQ-12).
- `devops init --dry-run` ends by saying it wrote nothing, instead of saying the
  project was initialized (#271, `specs/ops/analyzer-detection.md` REQ-4).
- `devops analyze` detects languages from file extensions when no manifest names
  one (#271, REQ-3): a breadth-first walk of at most depth 4 and 2,000 entries,
  read one entry at a time, skipping symbolic links, hidden folders and
  `node_modules`. A manifest still wins.
- `devops init` no longer leaves its safety gates silently off (#267,
  `specs/release/npm-package.md` REQ-3 and REQ-8).
  - It writes the pre-commit hook where Git runs hooks
    (`git rev-parse --git-path hooks`), so worktrees and submodules get one.
  - It writes nothing into a `core.hooksPath` folder and says what to add there.
  - It ends with a "Safety gates" summary: where the hook went or why there is
    none, and which copied Claude Code hook scripts no settings file references.
- `devops analyze` no longer calls a shallow clone, CI's default checkout, a new
  project (#263, `specs/ops/analyzer-detection.md`). A shallow clone's commit
  count is not read as the project's age, and the printed state says why. Its git
  commands now name the analyzed folder explicitly rather than relying on the
  working directory, which is the same folder today.
- `devops analyze` reads the dependencies of npm, yarn and pnpm workspace
  packages, not only the root `package.json`, so a monorepo's frameworks are
  detected (#264, `specs/ops/analyzer-detection.md` REQ-2). Expanding the
  repository's workspace patterns is bounded for any input: no regex
  backtracking, and at most 20,000 folder entries read.
- `package.json` writes its bin paths and repository URL the way `npm publish`
  normalizes them, so a publish corrects nothing. npm reported the old `./` bin
  paths as "invalid and removed", though it only dropped the `./`.
- When the release workflow's publish fails, it prints npm's trusted-publishing
  (OIDC) log lines; npm otherwise reports only `ENEEDAUTH`.

## [0.4.0] — 2026-10-11

The first release published to npm, as `@miltonadina/devops`.

Phase 3 (Memory & observability — Stratum closeout, Option B: Stratum
Phase 0 + 1 + 3 locked per session 7.5 audit) is underway on
`main`. Stratum has grown from the Phase 0 capture-proxy
scaffold described below into a subsystem of this same project (Fastify
proxy, multi-provider gateway, 3-tier memory on the Supabase API, run
against a local Supabase-compatible stack) — one project, not a separate
product. See `docs/LAUNCH_READINESS.md` for current, frequently-updated
status — this file intentionally does not duplicate that detail while the
phase is open.

### Added — npm package release (specs/release/npm-package.md)

- DevOPs installs from npm: `npm install -g @miltonadina/devops`, then `devops analyze` and `devops init` in a project. 0.4.0 is the first npm release; `docs/RELEASING.md` has the steps.
- **Fixed** for anyone installing from npm:
  - The commands read their files from the installed package; they no longer assume a `~/DevOPs` folder. `DEVOPS_ROOT` still points them at a checkout.
  - `devops-analyze` now works through npm's command symlink.
  - The TypeScript tools run with the package's own `tsx`, now a runtime dependency, so nothing is needed on PATH.
  - `devops toString` and similar inherited names are refused as unknown commands.
- **Changed:** `devops init` never replaces a git pre-commit hook another tool wrote. The hook it writes scans with `gitleaks --redact`, so a found secret stays out of the terminal, and validates claims with `devops verify`. `devops init --dry-run` writes nothing.
- **Removed:** the `devops-install` command and `scripts/install.sh`, which copied a clone into `~/DevOPs`. npm installs the package instead.
- The package ships the product and none of this repository's own records. It is 206 files, down from 289; the graph pipeline's pieces stay out, because they still assume this repository.
- CI's new `package-smoke` job packs, installs and runs the package on every pull request. It fails when a skill differs from its signed manifest entry. `.github/workflows/release-npm.yml` publishes a `vX.Y.Z` tag with provenance after checks and an approval.

### Added — limited managed session erasure (specs/memory/session-erasure.md, C4-B)

- Organization-only authenticated erasure for newly enrolled explicit sessions
  in a privileged, source-bound local generation. Preparation creates a durable
  fence; atomic deletion returns a stable receipt across transport loss/retry.
- Preserve shared and foreign data, reject late identity/source resurrection,
  and mark coverage permanently uncertain before protected application copying.
  Restore retains compatibility and cannot enroll imported identities.
- Seven additive migrations retain the historical schema ledger. The original
  operator database remains unactivated; the controlled real HTTP proof uses a
  fresh isolated stack and stops/disables its generation afterward.
- Broader historical/conversation/copy coverage, managed onboarding/restarts and
  the representative one-year performance gate remain open. Client responses,
  privileged snapshots and physical remnants are explicit exclusions.

### Changed — invoice schema and legacy recovery (specs/ops/payment-removal.md, C4-A)

- **Breaking:** M2 drops invoice reconciliation/payment RPCs and invoice tables
  together with their removal from backup exports and session inventory classes.
  Upgrade schema and recovery code together; historical migrations are retained.
- Restore accepts validated legacy invoice arrays, reports their names and counts,
  and skips their rows. Existing retired usage-column stripping and active-data
  validation remain.
- Erasure preflight no longer treats usage rows as financial retention. Unknown
  stores and missing execution still block erasure. The moved memory specification
  preserves deletion, isolation, shared-data, cache, retry and performance gates;
  ADR-0021 is superseded with its original rationale retained as history.
- Actual session erasure remains C4-B work; this entry does not complete C4 or v0.9.

### Changed — unsigned usage and payment module retirement (specs/ops/payment-removal.md, C2/C3)

- **Breaking:** M1 removes usage signatures, fee columns and mutation guards.
  Upgrade the unsigned writer and schema together; preserve the durable outbox
  during restart. Team usage needs no billing signing secret. Token counts,
  pinned prices and estimated USD differences remain.
- Legacy backups strip and report retired usage columns. Invoice tables still
  export and restore until the coordinated C4 migration.
- **Breaking:** removed the legacy payment library, invoice CLI, billing/Stripe
  verification commands, CLI-only read factory and payment types. Usage reads,
  generic outbound webhook signing, provider routing and PruningLog remain.
- Retired payment and duplicate old-module tests after preserving nonpayment
  coverage, including negative usage deltas and aggregation before rounding.
  C4's invoice schema and actual session-erasure work remain open.

### Changed — payment HTTP surface removal (specs/ops/payment-removal.md, C1)

- **Breaking:** removed the CFO page (`/billing`), invoice, invoice-list and
  audit CSV HTTP routes, and `POST /stripe/webhook`. The proxy no longer uses
  `STRIPE_WEBHOOK_SECRET`; OpenAPI omits the removed payment routes and schema.
- Kept `/v1/billing/summary` and `/v1/billing/records` as usage reads. They
  report token counts and estimated USD savings without fee or signature
  fields, and still refuse project-bound keys with 403. Session stats retain
  token counts and estimated USD savings without `feeUsd`.
- Plan lookup for request limits and token budgets now uses the sessions
  dependencies; the plan limits and starter fallback remain in place.
- Removed `invoice.ready` and `tee.attestation_failed` webhook types and
  the fee field from the `session.ended` sample.
- Signed ledger writes and their signing secret remain until C2. The invoice
  CLI, Stripe library and payment modules remain until C3; invoice tables
  remain until C4. C1 does not remove those components.

### Security — local network hardening (specs/security/stratum-local-network.md)

- **Breaking:** the bind-host setting is now `DEVOPS_PROXY_HOST`. `HOST` is
  deprecated — honored for one release only as an alias, used when
  `DEVOPS_PROXY_HOST` is unset or blank (`DEVOPS_PROXY_HOST` wins when both
  are set) — and logs a deprecation warning when it is set to a non-empty
  value. If your shell or CI exports `HOST` (some set it to the machine's
  name), a personal-mode proxy now refuses to start on that address: unset
  `HOST`, or set `DEVOPS_PROXY_HOST=127.0.0.1`.
- **Breaking:** in personal mode (no auth configured) the proxy answers a
  CORS preflight with `403`, never sends `Access-Control-Allow-Origin`, and
  refuses with `403` any request whose `Host` header is missing or isn't a
  loopback name: `127.0.0.1`, `localhost`, `[::1]`, or a loopback
  `DEVOPS_PROXY_HOST`, with no port or with the proxy's own listening port.
  Any other port gets `403`, so a port forward such as `localhost:5000` to a
  proxy listening on `4080` is refused. A browser app that called the proxy
  from another origin stops working.
- **Breaking:** in commercial mode (auth configured) the proxy sends
  `Access-Control-Allow-Origin` only for the origins listed in
  `DEVOPS_PROXY_CORS_ORIGINS`, which is empty by default; an entry `*` allows
  any origin. `DEVOPS_PROXY_ALLOWED_HOSTS` optionally limits which `Host`
  names it accepts; with it unset any `Host` is accepted.
- A request that carries more than one `Host` header gets `400`
  (`invalid_host`), in every mode.
- **Breaking:** with no auth configured, a non-loopback `DEVOPS_PROXY_HOST`
  (for example a bind-all address) refuses to start unless
  `DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1` is set, in which case the
  proxy starts and logs a warning. Loopback means `localhost`, an address in
  `127.0.0.0/8`, or `::1` (also written `[::1]`). The opt-in only allows the
  bind: with no auth every non-loopback `Host` still gets `403`, so it does
  not make the proxy reachable by its address. Reaching the proxy from
  another device takes auth (`CQ_COMMERCIAL` with Supabase credentials).
- **Breaking:** an invalid `PORT` (not an integer from 1 to 65535) or
  `RATE_LIMIT_MAX` (not a positive integer) refuses to start, and the message
  names the variable and the value it rejected.
- **Breaking:** a provider base URL (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
  `OPENROUTER_BASE_URL`, `GEMINI_BASE_URL` or `CQ_LOCAL_BASE_URL`) that uses
  plain `http` to a non-loopback host refuses to start unless
  `DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM=1` is set. A model server on another
  LAN host over plain `http` needs that opt-in; loopback `http` (a local
  Ollama or LM Studio server) and `https` are not affected by this rule.
- **Breaking:** a base URL that names the proxy's own listen address (a
  self-loop) refuses to start, and no setting overrides that.
- **Breaking:** the Docker image is removed: `runtime/Dockerfile` and
  `runtime/Dockerfile.dockerignore` are deleted. Run the proxy directly
  (`npm run dev` in `runtime/`); Docker Compose remains for the local
  database stack (`npm run db:start`) and does not host the proxy.
- Nothing changes for a command-line or SDK client on the same machine that
  connects to `localhost` or `127.0.0.1` on the proxy's own port.

### Added — repository hygiene check (quality plan QW-9)

- `scripts/check-repo-hygiene.mjs` runs in CI's `validate` job (`specs/ops/repo-hygiene.md`). It checks four things: every tracked file that starts with `#!` is executable, the plugin and version manifests carry the package version, no render or screenshot is committed outside an allowlist, and the root tests run by glob.
- 22 scripts with a shebang are now executable in git. `.claude-plugin/plugin.json` and `governance/VERSION.md` now say 0.3.0, the released version. The root `npm test` runs `tests/**/*.test.mjs`, so a new test file runs without editing a list.
- The empty `runtime/tests/` stubs are removed. Two stale acceptance criteria in the Phase 0 capture plan are corrected: its fixtures live in `runtime/test/fixtures/anthropic/`, and it never committed `.sse` files.

### Added — runtime lint gate in CI (quality plan QW-1)

- The required `runtime-test` job now runs `npm run lint` in `runtime/`. The script is `eslint src --ext .ts --max-warnings 0 && prettier --check src`, so an ESLint warning or an unformatted file fails the job (`specs/ops/ci-product-suites.md` REQ-3). Four files that Prettier flagged were reformatted; the layout changed, the code did not.

### Changed — `stratum/` is now `runtime/` (owner decision 2026-09-26)

- The runtime (proxy, memory, pruner) moved from `stratum/` to `runtime/`, and its package is `@miltonadina/devops-runtime` (ADR-0026; `specs/ops/one-platform-naming.md` REQ-5). **Breaking** for scripts that use the old path: use `cd runtime` and `npm --prefix runtime`.
- CI's required check `stratum-test` is now `runtime-test`, the test-floor key `stratum` is `runtime` (a declared rename, never a lowering), and the preflight check `deps.stratum` is `deps.runtime`.
- Unchanged: the local database's compose, container and volume names (`devops-stratum-*`) and the settings (`CQ_*`, `STRATUM_*`); a later naming cycle renames the settings.

### Changed — open source, no payment, local-first (owner decision 2026-09-26)

Recorded in `runtime/docs/decisions/0025-open-source-local-first-no-payment.md`.

- The roadmap no longer ends in a commercial product. `plan.md` §9 and
  `blueprint.md` redefine v1.0 as: a user points their AI agent at this
  repository and gets a working local setup on macOS, Linux and WSL2.
  `plan.md` §8 redefines v0.9 as payment removal plus self-hosted team
  features (organizations, API keys, usage estimates, session erasure).
- v0.7 (ZK-Context + AWS Nitro TEE) is dropped: the project hosts no server
  for an enclave to protect. Its Claude Code Security release-gate scan moves
  to v0.8.
- Release gates that waited for a deployment topology are measured on the
  user's machine instead. No gate changed its pass/fail state.
- The hour totals in `plan.md` §11, `blueprint.md` §5 and
  `docs/LAUNCH_READINESS.md` are withdrawn rather than recomputed.
- Token and USD figures stay, as information only. There is no fee and no
  invoice.
- New spec `specs/ops/payment-removal.md` holds the requirements for the
  graph cycles that will remove the payment code. That code (Stripe,
  invoices, the fee calculator, the signed ledger, the CFO page) is still in
  the tree until those cycles land.
- Positioning and pricing copy is rewritten in `README.md`,
  `stratum/README.md`, `stratum/landing.html` and the Stratum business and
  roadmap docs. The Stratum business documents are deleted:
  `stratum/docs/BUSINESS_MODEL.md`,
  `stratum/docs/INFRASTRUCTURE_AND_COST_PLAN.{md,html,pdf}`,
  `stratum/docs/PITCH.md` and `stratum/docs/DESIGN_PARTNER.md`, plus three hosted-era QA screenshots
  in `stratum/.workflow/` (including the CFO billing dashboard and the API docs page).

### Changed — open-source readiness, docs only (2026-09-26)

- Added a root `CODE_OF_CONDUCT.md` (moved from `stratum/`; contact through
  GitHub issues, or GitHub private vulnerability reporting for sensitive
  reports) and a root `.github/pull_request_template.md`.
- `docs/SECURITY.md` now names GitHub private vulnerability reporting as the
  reporting channel. The repository owner still has to enable that setting.
- README Quick start: the install script path is `./scripts/install.sh`, and
  the prerequisites are listed.
- Stratum docs: the URLs of a hosted proxy that does not exist and the unverified
  project email addresses are replaced by `http://localhost:4080` or GitHub
  links;
  `.env.example` uses the local database default and comments out unused
  hosted services; "proprietary" and "customer" wording is reworded.

### Removed — redundancy audit (2026-09-14)

A deliberate audit asked, per component: "does a good solution already
exist elsewhere?" — and removed what did, rather than maintaining a
reinvention. Full investigation trail and reasoning in-session; summary:

- **Zep memory backend** (`memory/zep/`, `mcp-configs/universal/memory-zep.json`)
  — zero real call sites anywhere in the codebase; Stratum's own
  `docs/decisions/0004-no-llm-summarization.md` argues its NL-summarization/
  graph approach is inferior to the structured-facts approach already
  chosen. Semantic-temporal recall ("what did anyone ever say about X?") is
  now unsupported — reopen if that need is confirmed.
- **`ask-dont-assume`, `karpathy-guidelines`, `surgical-edits` process
  skills** — all three duplicated Claude Code's own native behavior
  (clarifying-question defaults, `AskUserQuestion`, "no drive-by
  refactoring"). Where a skill had real enforcement behind it, that
  enforcement lives elsewhere and is unaffected: `verification/claim-validator.ts`
  for surgical-edits' "every line traces" rule; the `write-baton.sh`
  session-end hook for ask-dont-assume's blocker-gating.
- **`researcher` subagent** — duplicated Claude Code's native Explore agent
  type. All permission-denial references (pentest MCP tools, threat-model
  docs) updated to drop it; the `security` subagent's least-privilege
  scoping is unaffected.

**Explicitly NOT removed**, because investigation found real differentiated
function or load-bearing coupling, not just apparent overlap:
- Stratum's multi-provider gateway (billing-accuracy justified against
  LiteLLM, per ADR-0019) and Tier-2 Supabase memory (typed facts +
  trusted-FK + fail-closed, unlike mem0/Letta/Zep) — both live/deployed.
- The `security` subagent — it's the actual least-privilege permission
  boundary for the 4 pentest MCP tools, anchoring the sealed Phase 2 ASI02
  security control; cutting it would regress a sealed control, not clean up
  redundancy.
- The `reviewer` subagent — has a real spec-anchoring function distinct from
  its generic-review overlap with installed plugins.
- Stratum's `/dashboard` waste-viewer — confirmed redundant with Langfuse/
  Helicone, but left in place at the user's request since it's a route
  registered in the live production deployment; not touched this pass.

See `README.md`'s new "What's actually differentiated" section for the
resulting honest positioning.

---

## [0.3.0] — 2026-09-23

This release includes Phase 0 observation and Phase 1 measurement work, plus
the graph sprint dashboard and cycle-resume controls.

### Added

- Session capture and a measured waste taxonomy from real Claude Code traffic.
- Fastify measurement proxy with Anthropic forwarding, streaming, exact token
  counts, PII redaction, and a live cost and waste dashboard.
- Graph sprint dashboard, environment preflight, classified fault records,
  and mechanical `/sprint --resume` recovery.
- Claude Code security review integration and per-PR review guidance.

### Security and reliability

- Published repository visibility is now the owner-approved setting; the
  Phase 1 ship requirement and proof check were updated accordingly.
- CI validates claims, dashboard tests, Gitleaks, Semgrep, and the DeepTeam
  gate. DeepTeam visibly skips when no model-provider key is configured.
- Graph preflight tests now supply their own security-tool fixtures on CI.
- Stratum dependency updates clear the npm audit findings present in the
  prior lockfile; 825 unit tests and typecheck passed with the new versions.
- Claude semantic review reports a visible skip while the repository has no
  `CLAUDE_API_KEY`; no Claude review is claimed for this release.

### Remaining gates

- KadaneDial pruning remains out of the request path until the published
  Tier-A evaluation and real-use quality gates pass.
- Memory and audit features already in the tree retain their later-version
  acceptance gates; the v0.3.0 tag does not declare them production ready.

---

## [0.2.0] — 2026-05-25 — Phase 2: Security depth

Sealed on `phase-2-security-depth` (2026-05-24, session 8); full detail in
`governance/changelog/PHASE-2-CLOSURE.md`. 90/90 Phase 2 claims valid.

### Added
- Pentest stack integration (Shannon, PentAGI, Lyrie, pentest-ai)
- DeepTeam OWASP ASI 2026 red-team CI gate
- Prompt-injection defense hardening (rebuff + HMAC boundary,
  `observability/external-content-boundary.ts`)
- Stack-specific security skills
- Sigstore signing + signed skill manifest
- Skill provenance verification at install
- Webhook idempotency skill + analyzer detection
- Renovate template + `ci.yml` lint

### Security
- A.11 final-pass sec-review (ASI02 subagent least-privilege, ASI04
  external-content boundary) — both PASS

---

## [0.1.0] — 2026-05-22 — Phase 1: Foundation

### Added
- Initial repository scaffold with full directory architecture
- Constitution layer:
  - `PRINCIPLES.md` — eight principles (Karpathy 4 + DevOPs 4 extensions), each with tradeoff disclosure and observable working signal
  - `ANTIPATTERNS.md` — explicit don'ts with worked examples
  - `LOOP.md` — goal-driven iteration protocol
- Universal hook system with deterministic safety floor:
  - Pre-tool: secret block, prod-write block, `rm -rf` block, **budget brake** (hard USD cap with reserve-commit), **loop detection** (same-call-N-times), client boundary
  - Post-tool: auto-format, gitleaks scan, type check
  - Session-start: load baton, load constitution, verify project profile
  - Session-end: write baton, generate summary, log events
- Ten universal process skills (SKILL.md format):
  - spec-extraction (EARS notation)
  - plan-decomposition
  - baton-handoff (multi-tool session failover)
  - proof-of-work (claim verification)
  - session-summary
  - ask-dont-assume
  - multi-tool-failover (Claude Code → Codex → local LLM rotation)
  - karpathy-guidelines (vendored, MIT, attribution preserved)
  - goal-loop
  - surgical-edits
- Project analyzer:
  - Stack/domain/state/risk detection
  - Recommendation engine for Tier 3 per-project components
  - Installer
- Claim validator (TypeScript) — re-runs proofs, validates exit codes, computes reproducibility hashes
- Memory layer (three backends ready):
  - File-based memory at `memory/file-based/` (working today)
  - Stratum integration via `memory/stratum/` (uses Phase 0 capture proxy + Supabase fact tables)
  - Zep MCP integration via `memory/zep/` (self-hosted Docker compose)
- `AGENTS.md` root contract template
- `CLAUDE.md` Claude Code adapter (sources AGENTS.md)
- `.claude-plugin/plugin.json` — installable as a Claude Code plugin
- `.claude-plugin/marketplace.json` — marketplace metadata
- Mode scaffolding: greenfield, brownfield, migration, hotfix, refactor, debug-prod, audit
- Lifecycle phase scaffolding: discovery, design, build, harden, launch, operate, evolve
- Templates: ADR, EARS spec, threat model (STRIDE + OWASP ASI 2026), runbook, postmortem, SLO spec, status report
- Cost controls: model routing config, budget brakes, loop detection, batch routing
- Observability: OpenTelemetry config, Langfuse setup, Laminar setup, PII redaction
- `GAP_61_COVERAGE_MATRIX.md` — explicit map of where each of 61 identified design gaps is addressed
- Install script (cross-tool)

### Technical decisions
- Universal SKILL.md and AGENTS.md formats over tool-specific configs
- Karpathy guidelines (multica-ai, MIT) vendored rather than re-authored
- EARS notation as the default spec format
- Stratum schema adopted as the structured fact store from day one
- Three-tier model routing (Haiku/Sonnet/Opus) configured by default
- OpenTelemetry baggage for per-tenant cost attribution
- OWASP ASI 2026 baked into threat model templates

---

## Format reference

When adding entries to a new version, use these categories:

- **Added** — new features or capabilities
- **Changed** — changes to existing functionality
- **Deprecated** — features that will be removed in a future version
- **Removed** — features removed in this version
- **Fixed** — bug fixes
- **Security** — security-related changes (always document)
- **Performance** — measurable performance improvements with numbers
