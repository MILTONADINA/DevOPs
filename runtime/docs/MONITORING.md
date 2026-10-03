# MONITORING.md — Observability and Alerting

This page contains monitoring proposals, not a deployed metrics exporter,
alert service or scheduled job. [TELEMETRY.md](TELEMETRY.md) lists actual
emissions. Under C2, usage is unsigned and carries no fee; signature/fee
checks are retired. The local journal still fails closed and retains events
on replay failure.

## Philosophy

If it isn't measured, it isn't managed. CQ has three things that can go wrong silently:

1. **Pruning degrades quality** — the AI gives worse answers and nobody notices until the customer churns
2. **Token counts drift** — usage reports and estimated savings become inaccurate
3. **Memory facts corrupt** — Historical Drift goes undetected and the AI confidently hallucinates

The monitoring system exists to catch all three before the customer does.

---

## Key Metrics

### Pruning Health

| Metric | Description | Alert threshold |
|---|---|---|
| `pruning.effectiveness_pct` | `(original - quarantined) / original × 100` per session | < 60% → investigate (pruner may be broken) |
| `pruning.latency_ms` | ONNX encode + KadaneDial time | p99 > 20ms → alert |
| `pruning.zero_spans_rate` | % of sessions where KadaneDial returned no spans | > 5% → alert (check λ, g, θ config) |
| `eval.faithfulness` | Daily eval run score | < 0.90 → page on-call |
| `eval.answer_relevancy` | Daily eval run score | < 0.88 → page on-call |

### Usage Integrity (proposed metrics)

| Metric | Description | Alert threshold |
|---|---|---|
| `usage.token_count_mismatch` | Difference between exact counts for the same provider input; do not compare a labeled preflight estimate as exact | Investigate unexpected exact-count differences |
| `usage.negative_delta` | Sessions where quarantined > original tokens | Any non-zero → investigate |
| `usage.pending_events` | Events retained in the durable outbox | Investigate persistent backlog/replay errors; preserve files |

### Memory and Audit Health

| Metric | Description | Alert threshold |
|---|---|---|
| `audit.conflict_rate` | Historical Drift detections per 1000 facts | > 10 → investigate extraction quality |
| `audit.suppression_rate` | Facts suppressed per 1000 extracted | > 20 → extraction model may be hallucinating |
| `memory.extraction_failure_rate` | Zod validation failures per 1000 extraction attempts | > 5% → alert (Llama model or prompt issue) |
| `memory.tier2_latency_ms` | Supabase fact query latency | p95 > 80ms → alert |
| `memory.tier3_pinecone_latency_ms` | Pinecone vector query latency | p95 > 200ms → alert |
| `memory.promotion_job_duration_min` | Nightly T2 → T3 promotion job runtime | > 60 min → alert |

### Proxy Health

| Metric | Description | Alert threshold |
|---|---|---|
| `proxy.request_latency_ms` | Total proxy latency (excl. LLM) | p99 > 100ms → alert |
| `proxy.error_rate` | 5xx responses / total requests | > 0.1% → alert |
| `proxy.tee_attestation_failures` | Failed attestation verifications | Any → alert immediately |
| `proxy.upstream_error_rate` | Anthropic API errors | > 1% → alert |

---

## Logging

### Log Levels

| Level | When to use |
|---|---|
| `error` | Unrecoverable failures — TEE attestation failure, usage record not written, Zod validation crash |
| `warn` | Recoverable anomalies — Opus escalation triggered, Tier 3 fallback used, zero spans from KadaneDial |
| `info` | Normal operations — session started/ended, usage record written, fact extracted |
| `debug` | Verbose internals — individual turn scores, KadaneDial iteration steps. Disabled in production. |

### What to Never Log

- Any plaintext context content (enforced by architecture — context only decrypts inside TEE)
- Session encryption keys or derived keys
- Full request/response bodies (log metadata only: token counts, model, session ID)
- Customer API keys (log a masked version: `sk-ant-...xxxx`)

### Log Format

Proxy logs use structured JSON via `pino`. This proposed usage event is not
currently emitted; the actual per-turn fields are documented in TELEMETRY.md:

```json
{
  "level": "info",
  "time": "2026-04-06T14:23:00.000Z",
  "session_id": "uuid",
  "org_id": "uuid",
  "event": "usage.record.written",
  "original_tokens": 8420,
  "quarantined_tokens": 1180,
  "token_delta": 7240,
  "estimated_cost_delta_usd": 0.2172
}
```

Never use `console.log`. Always use the `pino` logger instance from `src/lib/logger.ts`.

---

## Dashboards

### Operator Dashboard (internal, Cloudflare Analytics + custom)

No hosted instance exists (ADR-0020), so there is no operator dashboard URL.

Panels:
- Request volume by org (last 24h, 7d, 30d)
- Pruning effectiveness distribution (histogram)
- Audit conflict rate over time
- Usage integrity and pending outbox events (unsigned rows are expected)
- Eval score trend (daily runs, last 30 days)
- Top 10 organizations by token delta (estimated savings for information)
- Error rate by endpoint

### User Dashboard (local, at `http://localhost:4080/dashboard`)

Panels:
- Today's sessions, token counts, savings
- Monthly savings trend
- Per-project breakdown
- Active Historical Drift conflicts (unacknowledged)
- Pending todos (from structured fact extraction)

---

## Alerting

### Alert Channels

- **PagerDuty (P1):** Any usage integrity issue, TEE attestation failure, eval score drop
- **Slack #cq-alerts (P2):** Pruning latency, memory promotion failure, error rate spike
- **Slack #cq-daily (info):** Daily eval scores, daily usage summary, conflict count

### On-Call Runbooks

#### Eval score dropped below threshold

```
1. Check: did any pruning code change in the last 24 hours? (git log)
2. Check: did the ONNX model or tokenizer version change?
3. Run: npm run test:eval -- --verbose to see which scenarios failed
4. If a specific scenario fails: check the pruning logs for those sessions
5. If all scenarios fail: check the embedding model is loading correctly
6. Rollback the last pruning change and re-run evals
7. Do NOT ship a fix without evals passing first
```

#### Token count mismatch detected

```
1. Stop the proxy if the mismatch affects persisted exact counts; preserve its outbox
2. Check: is @anthropic-ai/tokenizer on the correct version?
3. Check: are we using the correct model string when counting?
4. Compare: manually count a small session and compare to Anthropic's reported count
5. If drift is systematic: inspect affected usage records and pinned estimates
6. Notify affected customers before they ask
```

#### TEE attestation failure

```
1. Check: was the enclave updated recently? (check docs/enclave-pcr-values.md)
2. Check: is the client library version compatible with the current enclave?
3. Check: is AWS reporting any Nitro Enclave service issues?
4. If PCR mismatch: verify the build was reproducible (rebuild and compare PCRs)
5. If client version mismatch: coordinate a client library update
6. During resolution: disable ZK-Context for affected orgs (with their consent)
   Set org_config.zk_enabled = FALSE for affected org_id
```

#### Historical Drift spike (conflict rate > 10 per 1000)

```
1. Check: did the Git indexer run recently? (check nightly job logs)
2. Check: did any org push a large refactor that invalidated many old facts?
3. Check: is the Llama extraction model producing plausible-but-wrong facts?
4. If indexer issue: manually trigger re-index for affected repos
5. If extraction issue: review 10 random recent extracted facts for quality
6. If a specific fact type is failing: disable extraction for that type temporarily
```

---

## Daily Automated Checks

The original proposal was a nightly job; no such job is configured. This
pseudocode must not be treated as a deployed operational check:

```typescript
// Pseudocode for daily health check job
async function dailyHealthCheck() {
  // 1. Run eval suite (fast mode — Tier C only)
  const evalResults = await runEvals({ suite: 'golden' });
  await reportToSlack('#cq-daily', evalResults);
  if (evalResults.criticalFailures > 0) {
    await page('#cq-alerts', 'CRITICAL: eval golden queries failing');
  }

  // 2. Usage integrity; unsigned rows are expected after C2.
  const negativeDeltas = await countNegativeDeltaRecords();
  if (negativeDeltas > 0) {
    await page('#cq-alerts', `USAGE INTEGRITY: ${negativeDeltas} negative delta`);
  }

  // 3. Unacknowledged conflict count
  const conflicts = await countUnacknowledgedConflicts();
  await reportToSlack('#cq-daily', { unacknowledgedConflicts: conflicts });

  // 4. Memory promotion job status
  const promotionStatus = await getLastPromotionJobStatus();
  if (promotionStatus.failed) {
    await alertSlack('#cq-alerts', 'Nightly T2→T3 promotion failed');
  }
}
```

---

## SLA Targets (Enterprise)

| Metric | Target |
|---|---|
| Proxy uptime | 99.9% monthly |
| Proxy latency (excl. LLM) | p99 < 100ms |
| Billing record accuracy | 100% (zero tolerance) |
| Eval score | Faithfulness > 0.90 |
| Support response time (P1) | < 2 hours |
| Support response time (P2) | < 24 hours |
