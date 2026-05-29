# Stratum — Personal Use Guide (Phase 1 Measurement Proxy)

This is the daily workflow for running the Stratum proxy locally to **measure**
your Claude Code token usage and capture sessions for waste analysis.

> **Phase 1 = measurement only.** The proxy forwards your requests to Anthropic
> **unchanged**, counts tokens, and captures each turn. It does **not** prune or
> modify anything yet (that is Phase 2 / v0.4.x). Your responses are identical
> to talking to Anthropic directly.

---

## 1. One-time setup

```bash
cd stratum
npm install
```

Create `stratum/.env` (gitignored — never commit it):

```
ANTHROPIC_API_KEY=sk-ant-...     # required
# Optional:
PORT=4080                        # proxy port (default 4080)
ANTHROPIC_BASE_URL=https://api.anthropic.com   # upstream (default; override for testing)
RATE_LIMIT_MAX=100               # requests/min/IP (default 100)
RATE_LIMIT_WINDOW=1 minute       # rate-limit window (default "1 minute")
LOG_LEVEL=info
```

---

## 2. Start the proxy

```bash
npm run dev        # runs src/proxy/index.ts via ts-node; listens on 127.0.0.1:$PORT
```

You should see `CQ Proxy running (Phase 1 measurement)`.

> **Why `npm run dev` (ts-node) and not a built `dist/`?** The proxy consumes
> the shared PII redactor from the repo-root `observability/` subtree via the
> `@devops/*` path alias, which `tsc`'s `dist` emit can't span (tracked as
> PB-29). `ts-node` resolves the alias at runtime, so `npm run dev` is the
> supported Phase-1 run mode. `npm run build` runs a full typecheck.

---

## 3. Point Claude Code at it

In the terminal where you run Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4080
claude            # or run Claude Code normally
```

Now use Claude Code exactly as usual. Every `/v1/messages` call (streaming and
non-streaming) flows through the proxy, is token-counted + captured, then
forwarded to Anthropic. Your experience is unchanged.

---

## 4. See your usage — the dashboard

Open **http://localhost:4080/dashboard** in a browser. It shows:

- total sessions / turns / tokens (input + output),
- a rough USD cost estimate (heuristic — not a bill),
- the top waste categories detected (system-prompt repetition, tool-definition
  repetition, the "context tax" of re-sent history, duplicated large pastes),
- a per-session table.

`GET /dashboard/api` returns the same data as JSON.
`GET /health` is a liveness probe.

---

## 5. Where your data lives

Captured sessions are written to:

```
stratum/data/sessions/session-<uuid>.json
```

**This is YOUR data and is gitignored.** Each file accumulates the session's
turns, with **PII redacted** (email, phone, SSN, credit card, JWT, Bearer/sk-/
AWS keys) before anything is written to disk. Redaction is **FAIL-CLOSED**: if
the redactor ever errors on a turn, that turn is **dropped** (never written
un-redacted) and counted under `dropped_turns` — you'll see a stderr line
citing `AC-S15-2a-2.2`.

> The on-disk capture stores the **request** (redacted) + token counts + a
> **minimal response** (id / usage / stop_reason). Full response content is
> forwarded to you but not stored — Phase-1 waste analysis is about the
> *request* context bloat, not the answer.

---

## 6. The §2b workflow (what to actually do)

1. Run the proxy + route ≥5 **real, varied** Claude Code sessions through it
   (different projects/stacks: a web app, a refactor, a debugging session, a
   scripts repo, etc.). The more representative, the better.
2. Open the dashboard to eyeball the waste categories.
3. Read the captured JSON files and fill in `stratum/docs/waste-taxonomy.md` —
   especially the **#1 waste type**. That finding is load-bearing: it drives the
   Phase-2 (KadaneDial pruner) heuristic priorities.

> The dashboard's waste estimates are **directional heuristics** (chars/4 +
> coarse context-tax math), not provable token figures — per-message exact
> breakdowns are a deferred enhancement. Use them to *prioritize*, then confirm
> against the real captured JSON.

---

## 7. Stop / clean up

- **Stop the proxy:** `Ctrl+C`. It drains in-flight requests + flushes captures
  (SIGINT/SIGTERM graceful shutdown), then exits.
- **Reset Claude Code:** `unset ANTHROPIC_BASE_URL` (back to talking to Anthropic
  directly).
- **Clear captures:** delete files under `stratum/data/sessions/` (safe — they're
  local + gitignored).

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ANTHROPIC_API_KEY must be set` on start | Add it to `stratum/.env`. |
| `ANTHROPIC_BASE_URL ... not a parseable URL` / bad protocol on start | Fix the env value (http/https only); the proxy fails fast by design. |
| Claude Code gets `429 rate_limit_error` from the proxy | You exceeded `RATE_LIMIT_MAX`/min. Raise it in `.env` or wait a minute. |
| `502 upstream_unreachable` | Network/transport error reaching Anthropic; the proxy retried then surfaced it. Check connectivity. |
| Upstream 4xx/5xx | Passed through verbatim from Anthropic (e.g. overloaded, auth). Not captured. |
| Dashboard shows "No sessions captured yet" | Run at least one request through the proxy first (steps 2–3). |
| A turn shows under `dropped_turns` | The redactor errored on that turn → dropped FAIL-CLOSED (no un-redacted write). Rare; check the stderr line. |

---

**Status:** Phase 1 (measurement). Next: Phase 2 client-side KadaneDial pruner
(v0.4.x) — gated on a representative §2b capture corpus.
