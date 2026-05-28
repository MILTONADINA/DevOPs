# stratum/test/fixtures

Test fixtures for P0-A (Stratum Phase 0 capture, non-streaming).

## Anthropic response fixtures (`anthropic/`)

Mock `Anthropic.messages.create()` responses. Loaded via `loadMockResponse(name)`
in `test/mocks/anthropic-sdk.ts`.

| File | Shape | Purpose |
|---|---|---|
| `simple-text-response.json` | single `text` content block | passthrough baseline |
| `tool-use-response.json` | single `tool_use` content block | tool-call capture |
| `mixed-content-response.json` | `text` + `tool_use` blocks in one message | real Anthropic behavior with interleaved blocks |
| `multi-turn-response.json` | assistant turn referencing prior user message | multi-turn thread capture |
| `error-4xx-response.json` | Anthropic 4xx error envelope | client-error path |
| `error-5xx-response.json` | Anthropic 5xx error envelope | server-error path |

## Streaming fixtures (out of scope for P0-A)

**Streaming response fixtures are intentionally absent.** Streaming is greenfield
work for **P0-B** (Session 14+), re-scoped Session 13 from "fix CHANGELOG crash"
(which referenced a fictional changelog entry) to "implement streaming for the
first time" (~16-20h envelope).

A prior plan called for a `crash-replication.jsonl` fixture under
`anthropic-streams/`. That plan was retired in Session 13 because:

1. The CHANGELOG "crash" entry was fictional (lived in the Format Reference
   example code block of `stratum/CHANGELOG.md`; removed Session 13 Phase A).
2. `scripts/capture-session.ts` has no streaming code path; there is nothing
   to crash.

Streaming-test fixtures (`simple-stream.sse`, `tool-use-stream.sse`,
`abort-mid-stream.sse`, `network-drop.sse`, `anthropic-error-event.sse`, etc.)
will be authored in Session 14+ alongside the P0-B implementation per the
revised spec §3 P0-B scope + §4 P0-B ACs.

The P0-A mock SDK surface in `test/mocks/anthropic-sdk.ts` explicitly throws
on `messages.stream()` invocation — this is a deliberate scope guard against
accidental streaming work in P0-A.
