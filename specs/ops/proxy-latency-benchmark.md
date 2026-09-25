# Proxy latency benchmark and PR regression gate (v0.8)

**Status:** draft (2026-09-25). This is a graph backlog item, and the orchestrator does not land it directly (masterpiece roadmap decision 12).

**Scope:** `plan.md` §7b says "Performance benchmark suite (~5h). Latency p50/p99 tracked per release. Regression detection on PR (>20% slower = fail)." Today nothing measures what the proxy adds to a request:
- `bench:tiers` measures the memory tiers.
- `bench:audit-indexer` measures the git indexer.
- `setup-linux` measures cold setup.

## Definitions

- **Proxied latency.** The wall time for one request that goes from a client, through the real Stratum proxy (`buildProxy` with `buildStartOptions`), to a loopback mock upstream and back. It runs to the last byte of the response body; for a stream, that is the final SSE event.
- **Direct latency.** The same request sent from the same client straight to the mock upstream.
- **Overhead percentile.** For percentile p, the proxied p-th percentile minus the direct p-th percentile, both measured in the same round. Per-request subtraction is not used, because the two measurements are not paired.
- **Round.** One warm-up, then one measured pass of the whole workload, first against one build and then against the other.

## REQ-1: The benchmark runs the real proxy against a loopback mock upstream

WHEN `npm run bench:proxy` runs in `stratum/`, THE BENCHMARK SHALL start the real proxy on `127.0.0.1` with an ephemeral port in personal mode (no database). It SHALL point `ANTHROPIC_BASE_URL` at a mock Anthropic upstream that it starts on a different loopback port.
- The mock SHALL return a fixed, valid Messages response. It SHALL return that response non-streamed and also as an SSE stream, and SHALL add no artificial delay.
- The benchmark SHALL NOT use a provider key, a database, a model server or any non-loopback address. IF any of those is configured in the environment, THEN the benchmark SHALL ignore it and say so.

## REQ-2: A fixed, versioned workload

THE BENCHMARK SHALL send a fixed workload whose bodies are generated deterministically from a seed and versioned with the benchmark. The workload SHALL contain at least:
1. a one-turn small request;
2. a request of about 8,000 input tokens;
3. a 100-turn conversation.

Each workload SHALL run non-streamed and streamed, at concurrency 1 and at concurrency 8. The benchmark SHALL discard a warm-up of at least 50 requests per workload and measure at least 500 requests per workload.

## REQ-3: A machine-readable result with its environment

THE BENCHMARK SHALL write a JSON result. For each workload, streaming mode and concurrency level, the result SHALL contain:
- proxied, direct and overhead p50, p90 and p99 in milliseconds;
- the sample count;
- the error count.

The result SHALL also record:
- the Stratum commit SHA;
- the Node.js version;
- the operating system and CPU model;
- the workload version;
- the seed.

IF any measured request fails or the sample count for any cell is zero, THEN the benchmark SHALL exit non-zero. It SHALL NOT report a result with missing cells.

## REQ-4: The PR gate compares base and head on the same runner

WHEN CI runs for a pull request that changes `stratum/src/**`, `stratum/package*.json` or the benchmark itself, THE PIPELINE SHALL:
1. build the base commit and the head commit in one job;
2. run at least 5 alternating rounds (base, head, base, head, and so on);
3. compare the median across rounds of the proxied p50 and p99 for each cell.

Rules for the comparison:
- The job SHALL fail when, for any cell, head exceeds base by more than 20% **and** by more than an absolute floor: 1 ms at p50, 5 ms at p99.
- IF either build fails to benchmark, THEN the job SHALL fail. It SHALL NOT pass vacuously.
- The job SHALL print a table of every cell's base value, head value, ratio and verdict.

Decision recorded: the absolute floor exists because a 20% change on a sub-millisecond loopback overhead is within scheduler noise on hosted runners. Without the floor, the gate would flake and then be ignored. The floor is a documented constant, not a tuning knob. Changing it needs a spec amendment.

## REQ-5: Per-release record

WHEN a release is prepared, THE RELEASE STEPS SHALL:
- run the benchmark on the release commit;
- commit its JSON under `stratum/benchmarks/releases/<version>.json`;
- print the p50 and p99 trend across committed releases, via `npm run bench:proxy -- --trend`.

A release record SHALL say which machine produced it. Numbers from different machines SHALL NOT be compared as a trend without that caveat printed.

## REQ-6: The gate is shown to catch a real slowdown

THE BENCHMARK SHALL have a self-test mode. It adds a fixed delay (default 25% of the measured base p50, and at least 2 ms) in a pass-through relay between the client and the head build only. The proxy code is not changed. The comparison SHALL report that slowdown as a failure. A unit test SHALL cover the comparison function with:
- synthetic distributions below the threshold;
- distributions above the threshold;
- the absolute floor;
- a missing cell;
- zero samples.

## Out of scope

- Commercial mode with the local database, request-path memory and billing writes. Database round trips dominate it, and it needs the Compose stack. That is a follow-up, measured in `setup-linux` for information only.
- Upstream provider latency.
- The Cloudflare Worker entry (ADR-0005), which is unverified.
- Any change to the proxy's request path. This spec adds measurement only.

## Acceptance criteria

### AC-1 (REQ-1, REQ-3)
**Given** a clean checkout with `npm ci` done in `stratum/` and no `.env`, **when** `npm run bench:proxy` runs, **then** it prints a table and writes a JSON result with every cell populated. No socket leaves loopback (the harness checks each address it opens) and the exit code is 0.

### AC-2 (REQ-3)
**Given** the mock upstream returns an error for one request, **when** the benchmark runs, **then** it exits non-zero and names the cell.

### AC-3 (REQ-4)
**Given** a PR that touches `stratum/src/**`, **when** CI runs, **then** a `proxy-latency` job prints the base/head table from at least 5 alternating rounds, and it passes when nothing changed on the request path.

### AC-4 (REQ-6)
**Given** self-test mode, **when** the gate runs, **then** it fails and names the slowed cells. The unit tests for the comparison function each fail against a stub that always passes.

### AC-5 (REQ-5)
**Given** two committed release records, **when** `npm run bench:proxy -- --trend` runs, **then** it prints both releases' p50 and p99 and the machine each came from.

## Rollout

The `proxy-latency` job starts as non-required. It becomes a required check only after 10 consecutive PR runs on unchanged request paths have passed, with the pass/fail record kept in the job summaries. Adding it to the required set is a masterpiece decision-2 change, which the owner can override.
