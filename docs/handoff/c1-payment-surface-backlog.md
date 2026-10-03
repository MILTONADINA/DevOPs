Payment removal, cycle C1: remove the payment HTTP surface, re-home the plan reader, keep a token-only usage read API.

specRef: specs/ops/payment-removal.md. C1 implements REQ-1, REQ-2, REQ-3 and REQ-6, plus the every-cycle rules REQ-10 to REQ-15. The owner approved the spec on 2026-09-26 (spec batch 1; ADR-0025, open source with no payment). Read the whole spec first. It is the contract; this backlog adds the build plan, the decisions and the safety rules.

A three-lens review, with refute-by-default verification, checked this backlog against the spec and the code on main 98df7b2. It confirmed 28 findings, which are folded in below. Cycle S1 (specs/security/stratum-local-network.md) has since landed on main as PR #219 (3ac20df). It changed runtime/src/proxy/app.ts and index.ts:
- CORS and a Host allow-list. A personal-mode request needs a loopback Host with no port or with the listening port. buildProxy gained `listenPort` and `listenHost`, set by start() through `baseOptions()`.
- validation of PORT, RATE_LIMIT_MAX, DEVOPS_PROXY_HOST and the provider base URLs, in runtime/src/proxy/network-settings.ts and index.ts;
- deletion of runtime/Dockerfile.

Line numbers below come from main 98df7b2, before S1, so many have shifted. Re-read every file before editing it.

Map of the current code:
- runtime/src/proxy/routes/billing.ts: `makeBillingRoute(deps: BillingDeps)` registers seven routes.
  - Four are payment: `GET /billing` (the BILLING_HTML CFO page), `GET /v1/billing/invoice`, `GET /v1/billing/audit.csv` and `GET /v1/billing/invoices`.
  - Two are usage: `GET /v1/billing/summary` and `GET /v1/billing/records`.
  - `createSupabaseBillingDeps` builds five methods: `listBillingRecords`, `listRecords`, `developerBreakdown`, `getOrgPlan` and `listInvoices`. `listBillingRecords` and `developerBreakdown` use exact-count, id-ordered paging in blocks of 500 that fails closed.
  - The summary calls `generateInvoice` from runtime/src/billing/invoice.ts to get its totals and effectiveness.
  - The file also defines `round2cents`, `monthBounds`, the exported `resolveOrg`, and `isoParam`/`strParam`/`intParam`.
- runtime/src/proxy/routes/stripe-webhook.ts registers `POST /stripe/webhook` with its own raw-body parser. It imports from runtime/src/billing/stripe-webhook.ts.
- runtime/src/proxy/index.ts, `buildStartOptions`. Team mode is `commercialEnabled`.
  - It sets `opts.billing` and, when STRIPE_WEBHOOK_SECRET is set, `opts.stripeWebhook` (`StartEnv` declares STRIPE_WEBHOOK_SECRET).
  - A `getPlan` closure over `billing.getOrgPlan` feeds both `opts.rateLimitByPlan` and `createTokenBudget`. It turns null or a throw into "starter" and logs "getOrgPlan failed — defaulting to starter tier". docs/runbooks/INCIDENT_RESPONSE.md quotes that warning.
- runtime/src/proxy/rate-limit-tiers.ts: PLAN_RATE_LIMITS has starter (20/min), growth (60), enterprise (300) and custom (1000), and `planLimits()` maps any unknown plan to starter. There is NO "pro" tier.
- runtime/src/proxy/routes/sessions.ts:
  - `SessionsDeps.getPlan` runs the same `organizations.plan` query and drives the concurrent-session cap.
  - A private `resolveOrg` duplicates billing.ts's exported one.
  - `getSessionStats` reads `cq_fee_usd` and returns `feeUsd`.
- runtime/scripts/invoice.ts imports only `createSupabaseBillingDeps`, and calls `getOrgPlan` and `listBillingRecords`. `scripts/` is typechecked.
- runtime/src/proxy/openapi.ts:
  - payment content: the fee sentence "Charges 20% of token savings.", the `Invoice` schema, and the paths `/v1/billing/invoice`, `/v1/billing/invoices` and `/v1/billing/audit.csv`;
  - usage paths: `/v1/billing/summary` ("Monthly billing summary") and `/v1/billing/records`, which have no field schemas.
  The parity test runtime/test/proxy/openapi.test.ts builds the app with fakes (`billing: anyFake`) and probes every documented path.
- runtime/src/webhooks/events.ts: the type list, and sample payloads for `invoice.ready` and `tee.attestation_failed`. The `session.ended` sample also carries `cq_fee_usd`. Tests use the two removed types in runtime/test/proxy/webhook-route.test.ts and runtime/test/webhooks/webhooks.test.ts.
- runtime/vercel-src/entry.ts plumbs STRIPE_WEBHOOK_SECRET, and its header comment mentions the Stripe raw-body parser. runtime/vercel-src is not typechecked by `npm run typecheck`.
- runtime/src/proxy/routes/dashboard.ts shows "Est. cost (USD)" from `estimated_cost_usd`.
- Test files are not typechecked: tsconfig.typecheck.json covers src, scripts and evals. A stale option key in a test therefore fails silently.

Decisions already made, not ambiguities:
- D1 (REQ-1). Removal:
  - Delete the four payment routes and the CFO page from routes/billing.ts.
  - Delete runtime/src/proxy/routes/stripe-webhook.ts, and remove the `stripeWebhook` option from buildProxy.
  - Remove STRIPE_WEBHOOK_SECRET from `StartEnv`, from buildStartOptions and from runtime/vercel-src/entry.ts, including that file's header-comment text about the Stripe webhook and raw-body parser.
  - Leave runtime/src/billing/stripe-webhook.ts and its test for C3 (REQ-7).
  - Remove `invoice.ready` and `tee.attestation_failed` with their samples. Remove `cq_fee_usd` from the `session.ended` sample, because REQ-1 says no webhook payload carries it.
  - Tests that used a removed type switch to a surviving type, so they still test a known event and do not pass on an unknown-event 400.
- D2 (REQ-3). The usage read API keeps its paths, `GET /v1/billing/summary` and `GET /v1/billing/records`. Renaming paths or tables is out of scope.
  - `BuildProxyOptions` gets `usage?: UsageDeps`. app.ts registers `makeUsageRoute(opts.usage)` only when it is set, where the billing routes are registered today. It no longer takes `billing`.
  - A new runtime/src/proxy/routes/usage.ts exports:
    - `makeUsageRoute`;
    - `UsageDeps = { listUsageRecords, listRecords, developerBreakdown, getOrgPlan }`;
    - `createSupabaseUsageDeps(client)`.
    `getOrgPlan` is the same `organizations.plan` query. It is kept only for the summary's unknown-org 404, which stays.
  - buildStartOptions's team-mode branch sets `opts.usage = createSupabaseUsageDeps(client)`, and only that branch sets it. It no longer sets `opts.billing`.
  - `createSupabaseUsageDeps`:
    - keeps the exact paging of today's billing deps in `listUsageRecords` and `developerBreakdown`: blocks of 500 in id order with `{ count: "exact" }`, and org scope and date bounds on every page;
    - throws when the count is missing or not a safe non-negative integer, when it changes during paging, when a page comes back empty before the count is reached, or when the rows read exceed the count;
    - selects no `cq_fee_usd` or `signed_hash`, but still selects `cost_delta_usd`;
    - builds each records row from an explicit list of allowed fields.
    specs/billing/invoice-full-read.md REQ-2 applies to the kept summary through these guards.
  - A new runtime/src/usage/summary.ts defines its own `UsageRecord` of `{ session_id, original_tokens, quarantined_tokens, cost_delta_usd }` and computes the summary's totals exactly as generateInvoice does today:
    - `round2(n) = Math.round((n + Number.EPSILON) * 100) / 100` for `total_cost_delta_usd` and `average_pruning_effectiveness_pct`;
    - effectiveness 0 when total original tokens is 0;
    - token totals unrounded.
  - routes/usage.ts and usage/summary.ts import nothing from `./billing`, from `../../types/billing`, or from anything under `billing/`.
  - The summary drops `total_cq_fee_usd`, and `by_developer` drops its fee. The records keep their USD delta. REQ-6 treats those as estimates, not fees.
  - `getSessionStats` stops reading `cq_fee_usd` and stops returning `feeUsd`.
  - A project-bound key still gets 403 on both usage paths.
  - `monthBounds`, `isoParam`, `strParam` and `intParam` move to routes/usage.ts.
  - `resolveOrg` gets one home, the new runtime/src/proxy/routes/org-scope.ts, which only usage.ts and sessions.ts import. The memory, config and webhooks routes keep their own copies (out of scope).
- D3 (keep the invoice CLI compiling until C3). routes/billing.ts keeps only three things:
  - `BillingDeps = { getOrgPlan, listBillingRecords }`;
  - `createSupabaseBillingDeps`, returning only those two methods, with today's paging;
  - the `BillableRecord` type import from ../../billing/invoice.

  Everything else in that file goes. Its `listBillingRecords` keeps selecting `cq_fee_usd` and `signed_hash`, because the invoice CLI needs them. REQ-3's rule covers the usage read API and sessions.ts only, so the reviewer does not block on these reads. Add a header comment saying the file exists only for runtime/scripts/invoice.ts and that C3 deletes both. Nothing in runtime/src/proxy registers a route from billing.ts, and index.ts no longer imports ./routes/billing.
- D4 (REQ-2). The `getPlan` closure in index.ts calls `opts.sessions.getPlan(orgId)` when it runs, not a reference captured earlier. Its behaviour is unchanged: null or a throw means "starter", with the same warning text, "getOrgPlan failed — defaulting to starter tier".
  - Per-plan request limits, the token budget with its 60 s cache, and the concurrent-session cap behave as before.
  - C1 does not edit PLAN_RATE_LIMITS, `planLimits()` or `planRequestsPerMinute()`, and no test adds a plan name.
  - Removing the billing deps so that lookups fall through to starter does NOT satisfy REQ-2.
  - AC-2's tests run through buildStartOptions, in team mode, with a fake Supabase client. Wrap buildProxy around the returned options with an injected auth resolver; do not pass `rateLimitByPlan` directly. Then `vi.spyOn(opts.sessions!, 'getPlan')` and drive requests to an in-proxy /v1 route, as runtime/test/proxy/rate-limit.test.ts does.
    - (a) The spy returns "starter": the 21st request in a minute gets 429.
    - (b) The spy returns "growth": the 21st request is not 429 and the 61st is 429.
    - (c) The spy returns null or throws: the 21st request gets 429, and for the throw the warning above is logged.

    Assert that the spy was called with the organization's id.
  - The token budget: `opts.messages.tokenBudget.tryConsume` allows 60,000 tokens in a minute for "growth" and denies them for "starter". Pass `base.messages = {}`.
  - (a) and (b) are red on the current code, because the closure reads the billing deps and ignores the spy. If (c) passes on the current code, it takes the " (regression guard)" suffix and a comment naming the mutation it kills: the closure losing its `?? "starter"` fallback or its catch.
- D5 (REQ-6). USD figures stay, labelled as estimates. JSON field names do not change in C1.
  - OpenAPI: the path summaries become:
    - "Monthly usage summary (token totals; USD figures are estimates)";
    - "Paginated usage records (USD delta is an estimate)";
    - the session-stats path: "Session token totals and estimated savings (USD)".

    Each 200 description says "USD figures are estimates for information, not fees or charges". Add no component schemas.
  - docs/API_REFERENCE.md calls each USD field an estimate.
  - The dashboard's existing "Est. cost (USD)" counts as an estimate label, so C1 does not change dashboard.ts.
  - The AC-6 tests cover the summary, the records, the session stats and the personal dashboard. The dashboard test goes in runtime/test/proxy/dashboard.test.ts, titled `specs/ops/payment-removal.md#AC-6 dashboard shows an estimated USD cost and no fee (regression guard)`. Its comment names the mutation it kills: dropping "Est." or adding a fee, charge or amount-due card or field.
    - The data response has a numeric `estimated_cost_usd` and token totals, and no key matching /fee|charge|amount_due|minimum/i.
    - The HTML contains "Est. cost (USD)" and does not match /fee|charge|amount due/i. Confirm first that the pattern has no false positive in the page.
- D6 (REQ-12). Removed tests lower the runtime floor only through a new `lowerings` entry in governance/test-floors.json:
  - `suite` is `runtime`;
  - `from` is main's runtime floor when this cycle starts (1415 after S1; read it);
  - `to` is the passing count measured in a fresh worktree (T7);
  - `reason` names this cycle;
  - `decision` cites "owner decision 2026-09-26 (ADR-0025): open source, no payment".

  The ratchet prints `test floors: LOWERED runtime <from> -> <to>: <reason>`. The root floor changes only if a root test is added or removed. The review estimated about 25 removed tests, but the entry uses the measured count, never an estimate.
- D7 (spec conflicts, REQ-15).
  - specs/billing/project-key-access.md, before its first `##` heading:
    - add `**Status**: implemented (amended <this cycle's date> by specs/ops/payment-removal.md REQ-1)`;
    - add an `**Amended**` line saying the payment paths and the `/billing` shell were removed by REQ-1, and the project-key 403 rule now covers only `GET /v1/billing/summary` and `GET /v1/billing/records`;
    - fix the REQ prose to match.

    In the same diff, remove that spec from `spec_status` in governance/traceability-baseline.json and change nothing else there. Do not use `superseded`: the 403 rule stays.
  - specs/billing/invoice-full-read.md gets an `**Amended**` line. It says the CFO invoice and CSV paths were removed by REQ-1, and that its REQ-2 now covers the usage summary (served from routes/usage.ts) and the invoice CLI, which stays until C3. Do not describe the CLI or the invoice modules as removed. Leave its status and baseline entry as they are.
- D8 (REQ-15). These documents change in the same cycle. None may describe a C2 to C4 component (ledger signing, the invoice modules and tables, the invoice CLI) as removed.
  - runtime/docs/API_REFERENCE.md:
    - the billing intro and the summary, records and invoices sections;
    - `POST /stripe/webhook`;
    - the stale operation count;
    - the webhooks table;
    - the session-stats `cq_fee_usd` row. The code returns `feeUsd` today and will return neither.
    Keep S1's authentication section intact.
  - runtime/docs/WEBHOOKS.md: `session.ended`'s `cq_fee_usd`, the `invoice.ready` and `tee.attestation_failed` sections, and the `invoice_url` to a route that never existed.
  - runtime/docs/ARCHITECTURE.md: the plan reader, Stripe, and the `/billing` row.
  - runtime/docs/INTEGRATIONS.md, around the jq example that reads fee fields: replace it with fields the endpoint really returns, for example `jq '.[] | {id, model, created_at}'` on GET /v1/sessions. Do not name `cq_fee_usd` or `feeUsd`.
  - runtime/docs/COMMERCIAL_ONBOARDING.md, DEPLOYMENT.md, MEMORY_AND_EVAL_COMMANDS.md, TELEMETRY.md, MONITORING.md and runtime/README.md, wherever they name a removed route.
  - runtime/.env.example: delete the STRIPE_WEBHOOK_SECRET comment and variable. Keep STRIPE_SECRET_KEY and its section, because the invoice CLI and verify-stripe use it until C3. Reword the header so it does not call this a billing feature.
  - docs/runbooks/INCIDENT_RESPONSE.md: delete the STRIPE_WEBHOOK_SECRET rotation row and the index.ts Stripe citation. Re-point the plan-lookup warning's citations.
  - Every `runtime/src/proxy/index.ts:N` citation in docs/runbooks/*.md and runtime/docs/*.md that C1's edit moves is re-pointed to the post-C1 line. Check with `git grep -n "proxy/index.ts:" -- docs runtime/docs`.
  - runtime/docs/ROADMAP.md: tick only the C1 item.
  - CHANGELOG.md under Unreleased.
- D9 (the test disposition). A test of a removed surface is deleted. A test of kept behaviour is moved with its assertions intact.
  - Delete:
    - the invoice, `/billing`, audit.csv and invoices tests in runtime/test/proxy/billing-route.test.ts;
    - runtime/test/proxy/stripe-webhook-route.test.ts;
    - runtime/test/proxy/commercial-lifecycle.test.ts, or trim it to its non-payment cases if it has any;
    - the start-options "Stripe webhook is wired only when STRIPE_WEBHOOK_SECRET is set" test, which becomes one assertion: `stripeWebhook` is absent even when the secret is set, in both modes.
  - Move, as pure relocations with a " (regression guard)" suffix:
    - the four resolveOrg cross-tenant cases, to a test of routes/org-scope.ts;
    - the monthBounds test, to the usage test;
    - to the usage route test:
      - the summary and records route tests;
      - malformed since/until returning 400 with the "must be an ISO-8601 timestamp" message, on both paths;
      - scoping to the authenticated org when auth is on;
      - 400 when no org resolves;
      - the summary's 400 on a bad month and 404 for an unknown org.
  - Rewrite as AC-3: the two project-bound 403 tests, over the two usage paths.
  - Update:
    - start-options.test.ts: `opts.usage` is defined in team mode and undefined in personal mode, and neither mode has a `billing` or `stripeWebhook` key;
    - openapi.test.ts: `usage: anyFake` in place of `billing: anyFake`;
    - sessions-route.test.ts: the STATS fixture loses `feeUsd`;
    - the webhook tests, per D1.
  - runtime/test/billing/billing-deps-read.test.ts stays, pointed at the kept billing factory. The developerBreakdown case is copied, not moved, to the usage-deps test.

SECURITY RULES:
- Never read, print, list, copy or scan any `.env` file. runtime/.env holds real keys.
- Every process you start from runtime/ sets `DOTENV_CONFIG_PATH` to a path that does not exist, so no real key loads.
- Every gitleaks run passes `--redact` and never scans a directory:
  - for the modified tracked files, `gitleaks git --pre-commit --redact --no-banner --exit-code 99 --config governance/gitleaks-ci.toml`;
  - for each new untracked file, named one by one from `git ls-files --others --exclude-standard`, `gitleaks dir --redact --no-banner --exit-code 99 --config governance/gitleaks-ci.toml <that file>`.
- Drive any scratch git repository or worktree with `git -C <absolute path>`, and guard any `cd` into it: `cd "$W" || exit 1`. Never run `git config` yourself. Root `npm run setup` sets `core.hooksPath` to `.githooks`; the proof may run setup as it is.
- Never contact the retired hosted Supabase project. The only database is the local Compose stack (`devops-stratum-local-*`, loopback).

Scope guards (REQ-10, REQ-11 and REQ-13; AC-10):
- Stage nothing, anywhere. Stage nothing under runtime/src/billing/ or runtime/src/proxy/providers/, not even a comment.
- Do not edit an existing migration. C1 adds none.
- Do not edit runtime/evals/datasets/golden/tier-c.jsonl or the pges-fixture files.
- Do not touch the usage recorder, the outbox or the signing secret: those are C2.
- Do not change S1's Host, CORS or startup-validation behaviour (runtime/src/proxy/network-settings.ts, and the Host/CORS hook in app.ts).
- No commit, push or PR.

Tasks. Each code task is red-first: write its AC tests, show them failing on the current code, then implement.
T1 (REQ-1; AC-1). The removals in D1, the OpenAPI payment paths, the Invoice schema and the fee sentence.
  - The route test builds the app through `buildStartOptions(env, base, () => fakeClient)`:
    - `env` is a separate variable holding CQ_COMMERCIAL "true", SUPABASE_URL, SUPABASE_SERVICE_KEY, a dummy CQ_BILLING_SIGNING_SECRET and STRIPE_WEBHOOK_SECRET "whsec_test". Keep it as a separate variable so the removed StartEnv key does not fail type checks.
    - Before calling buildProxy, stub `opts.auth.resolve` to return an org-level key: an orgId and keyId, with no projectScopeId.
    - With that key, `GET /billing`, `GET /v1/billing/invoice`, `GET /v1/billing/audit.csv` and `GET /v1/billing/invoices` return 404. `POST /stripe/webhook` with content-type application/json returns 404.
    - On main these return 200 or 400, so the test starts red.
  - OpenAPI:
    - `JSON.stringify(OPENAPI_SPEC)` does not match /fee|amount_?due|monthly_?minimum|charges/i;
    - `components.schemas` has no `Invoice`;
    - the three usage-path texts contain "estimate";
    - the parity test passes.
  - No webhook sample contains `cq_fee_usd`.
T2 (REQ-2; AC-2). The plan-reader re-home and its tests (D4). Add a check that index.ts no longer imports ./routes/billing.
T3 (REQ-3, REQ-6; AC-3, AC-6). routes/usage.ts, usage/summary.ts, routes/org-scope.ts, the fee-free session stats, and the wiring (D2, D5). Tests:
  - The wiring test builds `buildProxy(buildStartOptions(teamEnv, base, fakeClient))` with a fake client whose key resolves to an org. `GET /v1/billing/summary` and `GET /v1/billing/records` return something other than 404.
  - runtime/test/proxy/usage-deps-read.test.ts. Its fake client records every column string passed to `select()` and returns rows that include `cq_fee_usd` and `signed_hash`. It covers:
    - (a) `listUsageRecords` reads 1,001 rows over pages at 0, 500 and 1000, with the same org and date bounds on every page;
    - (b) `developerBreakdown` counts every row: a token_delta of 50,050 and no fee key;
    - (c) both reject a missing count, a changed count and a stalled page;
    - (d) no select string names `cq_fee_usd` or `signed_hash`, and `cost_delta_usd` is still selected;
    - (e) the returned records and by_developer entries, and `getSessionStats`'s object (via createSupabaseSessionsDeps with the same recording fake), have no key matching /fee|amount_due|minimum|signed_hash/.
  - The summary maths, with literal values and no call to generateInvoice:
    - the existing fixture (50,000 and 7,500 tokens, cost delta 0.6375) gives `total_cost_delta_usd` 0.64 and effectiveness 85;
    - cost deltas summing to 1.275 give 1.28;
    - a month with no records gives effectiveness 0 and `total_cost_delta_usd` 0.

    These pass on the pre-change code, so they take the regression-guard suffix and a comment naming the mutation they kill: dropping EPSILON, dropping round2, or dropping the zero-token guard.
  - The project-bound 403 on both usage paths, and the D9 moves.
T4 (D3). Trim routes/billing.ts. Add a polish-backlog note for C3: C3 deletes routes/billing.ts together with scripts/invoice.ts.
T5 (D7, D8; REQ-15). The spec amendments and the documents.
T6 (REQ-12; AC-11 in use). The floor lowering entry (D6), from T7's measured count.
T7 (REQ-14; AC-12). Proof on the running system. The validator re-runs every item itself and reports exit codes.
  - In runtime/: `npm run typecheck`, `npm run lint` and `DOTENV_CONFIG_PATH=/nonexistent npx vitest run` exit 0.
  - The Vercel adapter typechecks.
    - Make a scratch tsconfig in a temp directory outside the repository. It extends the absolute path of runtime/tsconfig.typecheck.json and lists `include` as absolute paths to runtime/src, runtime/scripts, runtime/evals and runtime/vercel-src.
    - Run `npx tsc --noEmit -p <scratch>` from runtime/ on main first (the baseline), then on the change. Both must exit 0.
  - The measured count, taken in a fresh worktree:
    1. Run `git -C <live> worktree add <W> <main sha the cycle started from>`.
    2. Check that `npm ci` then `DOTENV_CONFIG_PATH=/nonexistent npx vitest run` in <W>/runtime passes exactly main's runtime floor. If it does not, stop and explain the difference.
    3. Carry the change over with `git -C <live> diff --binary HEAD | git -C <W> apply`, and copy each new file from `git ls-files --others --exclude-standard` by name.
    4. Run vitest again. The passing count is D6's `to`.
    5. Confirm that neither runtime/evals/datasets/locomo/locomo10.json nor runtime/evals/datasets/longmemeval/longmemeval_oracle.json exists in <W>.
    6. Record the result in the floors `_comment`, as earlier entries do, then remove <W>.
  - Root:
    - `npm test` exits 0;
    - `node scripts/lint-spec-status.mjs` exits 0, with one more passing spec and one fewer baselined;
    - `node scripts/lint-spec-status.mjs --ratchet <main's governance/traceability-baseline.json saved to a temp file>` exits 0;
    - `node scripts/check-test-floor.mjs --ratchet <main's floors file saved to a temp file>` exits 0 and prints the LOWERED line.
  - `node scripts/check-repo-hygiene.mjs` exits 0. It tolerates unstaged deletions (#218).
  - Every runtime/test/integration/*.sql file passes against the local stack with `ON_ERROR_STOP`, using the loop in CI's setup-linux job (read .github/workflows/ci.yml).
  - Root `npm run setup` exits 0, including its smoke boot. It uses the existing local stack and must not delete or recreate the database volume.
  - A team-mode boot, from runtime/:
    - Start it in the background: `npm run db:with-env -- env DOTENV_CONFIG_PATH=/nonexistent CQ_COMMERCIAL=true CQ_BILLING_SIGNING_SECRET=<32 random bytes, hex, made for this run> STRIPE_WEBHOOK_SECRET=whsec_<random hex> CQ_LOCAL_BASE_URL=http://127.0.0.1:1/v1 PORT=4181 npx tsx src/proxy/index.ts`.
    - Confirm the process is alive and its log has no startup refusal.
    - Then, with `-H 'Host: 127.0.0.1:4181'`:
      - `/health` returns 200;
      - `POST /stripe/webhook` returns 404 (it returns 400 on main);
      - `GET /billing` returns 404 (it returns 200 on main);
      - `GET /v1/billing/summary` returns 401: the route exists behind the auth gate.
    - Stop the process.

    The signing secret is still required in team mode until C2 (REQ-5). It is a throwaway local value, never a real one.
  - These print nothing:
    - `git grep -n STRIPE_WEBHOOK_SECRET -- runtime/src/proxy runtime/vercel-src runtime/test/proxy`. runtime/scripts/verify-stripe.ts may still match until C3.
    - `grep -nE "cq_fee_usd|signed_hash|feeUsd" runtime/src/proxy/routes/usage.ts runtime/src/usage/summary.ts runtime/src/proxy/routes/sessions.ts`.
  - routes/usage.ts, usage/summary.ts, routes/org-scope.ts, sessions.ts, app.ts, index.ts and openapi.ts import nothing from `./billing`, `types/billing` or anything under `billing/`. REQ-7's full importer check is C3's.
  - AC-10: `git diff --name-only` and `git ls-files --others --exclude-standard` list nothing under runtime/src/billing/, runtime/src/proxy/providers/ or runtime/supabase/migrations/, and none of the REQ-13 files.

Proof and sign-off rules:
- The reviewer checks the diff against the spec's REQ-1, REQ-2, REQ-3, REQ-6 and REQ-10 to REQ-15, not against this backlog's prose. It blocks on:
  - any behaviour change to plan limits, the token budget or the session cap;
  - any fee field that survives in a usage response or webhook payload;
  - a false comment or doc sentence this diff wrote;
  - a new test that passes on main without the regression-guard suffix.
- The security role runs the SECURITY RULES scans and semgrep on the changed files. It checks that:
  - no auth-protected route became public;
  - the project-bound 403 holds on both usage paths;
  - the cross-tenant resolveOrg refusal is still tested;
  - removing the Stripe webhook left no raw-body parser registered for another path;
  - S1's Host and CORS checks still run first.
- The validator refuses sign-off if:
  - AC-1, AC-2, AC-3 or AC-6 has no named test;
  - the floor falls without a matching `lowerings` entry;
  - a T7 item was not re-run;
  - D9's disposition list, written in the cycle proof, misses a test from the deleted blocks, or marks a kept-behaviour test as removed;
  - the cross-tenant `?org-id` refusal tests (auth on, no orgId gives undefined, then 400) no longer exist.
- Each test title names its AC as `specs/ops/payment-removal.md#AC-n`. A new test that passes on the pre-change code carries the suffix " (regression guard)" and a comment naming the mutation that kills it.
- Shipped source and test comments name the spec (REQ-n, AC-n) and "owner decision" where relevant. They do not name pipeline task ids (T1, T4a) or backlog decision labels (D1 to D9), because those mean nothing to a reader of the repository.
- Do NOT fill blocked_by_environment unless graph-classify-fault.mjs or the preflight reported a real environment, API or transient fault. If Docker or the local stack is down, that is an environment fault: classify it and report it.

Out of scope:
- C2: the unsigned ledger, migration M1, moving the usage modules out of runtime/src/billing/, and the signing secret.
- C3: deleting runtime/src/billing/, scripts/invoice.ts, routes/billing.ts and the payment types.
- C4: migration M2, session erasure and backup restore.
- Renaming `billing_records`, `CQ_COMMERCIAL`, the `/v1/billing/*` usage paths or the plan tiers.
- Removing the Vercel adapter. D1 still edits runtime/vercel-src/entry.ts.
- The gateway.
- S1's settings and Host/CORS behaviour.
