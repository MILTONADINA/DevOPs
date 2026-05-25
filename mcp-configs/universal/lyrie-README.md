# Lyrie — RAG-based Vulnerability Research Assistant MCP

Config: [`lyrie.json`](./lyrie.json)

## Purpose

Lyrie is the **research surface** of the pentest stack — a RAG-based assistant
that answers questions about CVEs, exploit patterns, and security literature
without itself executing any offensive action. Shannon and PentAGI invoke
Lyrie when their reasoning needs background context ("what's known about
CVE-2024-XXXXX in this version range?", "what payloads bypass this WAF
class?"); Lyrie returns text grounded in its RAG corpus.

The defining threat is **ASI04 (Indirect Prompt Injection)** — the RAG corpus
is an attacker-influenceable channel. A CVE description, a write-up in an
indexed forum, a blog post in the corpus could embed instructions that hijack
the consuming agent if Lyrie's output is treated as instructions. **Lyrie
output MUST pass through area C's `external-content-boundary.ts` before
re-entering agent context.** This is a hard cross-area dependency captured in
plan A task A.11 (Phase 2 final-pass verification, runs after C.05 ships).

## Auth

| Variable | Required | Purpose |
|----------|----------|---------|
| `LYRIE_API_KEY` | yes | Lyrie platform API token |
| `LYRIE_CORPUS_PATH` | no (default `./security-corpus`) | Path to the RAG corpus snapshot |

Note Lyrie's auth surface differs from Shannon/PentAGI: it has **no
AUTHORIZED_SCOPE** because Lyrie is read-only on external knowledge — it does
not touch the project's target system. The scope discipline applies to the
offensive tools, not the research surface.

## Example invocation

```
lyrie.research({
  query: "RCE patterns affecting Node.js child_process in 2025-2026",
  max_passages: 5
})
```

Lyrie's response carries the wrapper that area C's boundary applies:

```xml
<external-content untrusted="true" source="lyrie-rag" hmac="...">
... the research excerpt ...
</external-content>
```

Without the boundary wrapping (or with an invalid HMAC), the pre-tool hook
`hooks/universal/pre-tool/external-content-boundary.sh` halts any downstream
tool call. This is the cryptographic gate that closes the ASI04 path.

## Upstream

Forward-looking integration. Upstream confirmation at v0.2.0 release via the
upstream-maintenance cadence (task A.12). DevOPs-side MCP wrapper package
`@miltonadina/lyrie-mcp` is reserved.

Threat-model context (ASI04 Indirect Prompt Injection — primary; ASI01 Goal
Hijacking secondary if corpus is curated by an attacker): see
`docs/threat-models/phase-2/A-pentest-stack.md`.
