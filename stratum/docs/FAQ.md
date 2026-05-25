# FAQ.md — Frequently Asked Questions

---

## Product Questions

### What exactly is the Context Tax?

When you send a message to an LLM, you pay for every token in the request — including all the history, tool outputs, system prompts, and file contents that accumulated in the context window before your message. Most of that context is irrelevant to your current question. The Context Tax is the cost of that irrelevant context. In long-running Claude Code sessions, it typically represents 70–90% of your total API spend.

### How is CQ different from just truncating the context window?

Truncation cuts from the beginning — it removes the oldest context regardless of whether it's relevant. KadaneDial removes the least relevant context regardless of when it occurred. A decision made six months ago that directly answers your current question will be retained. A file you read 10 minutes ago that has nothing to do with your current query will be pruned. Truncation is a blunt instrument. CQ is a semantic surgeon.

### Will CQ make my AI less accurate?

That is the central question we take seriously. Our eval suite measures this on every build against three published benchmarks (LoCoMo, MT-Bench+, SCM4LLMs) plus our own developer-specific scenarios. The threshold is strict: Faithfulness must remain above 0.90 and Answer Relevancy above 0.88 compared to the full-context baseline. If a pruning change causes degradation beyond 5%, it does not ship. In practice, many users report the AI becomes more accurate because it is no longer distracted by noise.

### What does "Git-Attested Memory" mean?

When CQ stores a memory about your codebase — for example, "the `getUser()` function was deprecated in favor of `fetchUser()`" — it links that memory to the Git commit where the change happened. Before injecting that memory into future AI context, CQ queries your Git history to verify the fact is still true. If a later commit deleted `fetchUser()`, CQ detects the conflict and suppresses the stale memory rather than letting the AI hallucinate your own codebase back at you.

### What is ZK-Context?

ZK-Context is CQ's encryption architecture. Your raw session context is encrypted on your local machine before it is sent to the CQ proxy. Decryption only happens inside an AWS Nitro Enclave — a hardware-isolated compute environment that even CQ operators cannot access. The Nitro Enclave produces a cryptographic attestation document that you can verify independently: it proves the exact code running inside the enclave is the published CQ code, not a modified version. ZK-Context is available on Enterprise plans.

### Does CQ store my code?

No. CQ's Tier 2 (Warm Memory) stores structured facts extracted from your sessions — typed records like `FunctionChange`, `TechDecision`, `PolicyUpdate`. It does not store raw conversation content or source code. Tier 3 (Cold Memory) stores embeddings (mathematical representations) of those facts and graph relationships between entities. Embeddings are not reversible to the original text. With ZK-Context enabled, even the structured facts are derived from encrypted inputs that CQ never sees in plaintext.

### How does the 20% arbitrage fee work exactly?

Before sending your request to the Anthropic API, CQ counts the exact tokens in your original (unpruned) message. After pruning, it counts the quarantined (pruned) message. The difference is the token delta. We multiply that delta by Anthropic's current price per token to get the cost savings in dollars. Your fee is 20% of that dollar savings. Every billing record is signed with HMAC-SHA256 and linked to a pruning log so you can verify the math independently.

### What happens if CQ is down?

If the CQ proxy is unavailable, your Claude Code requests will fail. We recommend configuring a fallback: if the proxy returns an error, retry directly against `api.anthropic.com`. Your code quality doesn't degrade — you just pay full price for that session. Enterprise plans include an SLA with 99.9% uptime guarantee and a status page at `status.startum.com`.

### Can I use CQ with OpenAI or Gemini?

The MVP targets the Anthropic API specifically, including the exact token counting endpoint. OpenAI compatibility is on the roadmap for Phase 6+. The core algorithm is model-agnostic — the constraint is the billing integration, which requires exact token counts from the upstream provider.

---

## Technical Questions

### How do I point Claude Code at CQ?

```bash
export ANTHROPIC_BASE_URL=http://localhost:4080  # local dev
# or
export ANTHROPIC_BASE_URL=https://proxy.startum.com  # production
```

Claude Code respects the `ANTHROPIC_BASE_URL` environment variable and will route all API calls through it. No other configuration is required.

### Does CQ work with streaming responses?

Yes. The proxy forwards streaming responses from the Anthropic API to the client without buffering. Token counting uses the Anthropic SDK's `countTokens` endpoint before the request, not post-hoc from the stream.

### How does CQ handle tool calls and tool results?

Tool definitions (sent in the `tools` array) and tool results (sent as `tool` role messages) are both candidates for pruning. Repetitive tool output — the same file being read multiple times, identical bash outputs — is particularly aggressively pruned because it is high-token and low-relevance. Active tool calls (the current in-flight tool use) are never pruned.

### What embedding model does CQ use?

`all-MiniLM-L6-v2` (INT8 quantized, ONNX format) by default. This produces 384-dimensional embeddings and runs under 10ms on a mid-range laptop CPU. The model is downloaded once and cached locally. You can configure a different ONNX-compatible bi-encoder per organization via the API, but the default has been validated against our eval suite.

### What is the decay factor λ and how do I tune it?

λ controls how quickly older context loses relevance weight. The default is 0.97 per hour — context from 24 hours ago retains ~47% of its weight. If your team works in short, intense bursts (everything relevant was said in the last 2 hours), a lower λ (e.g., 0.90) will prune older history more aggressively. If your sessions span weeks with important decisions made months ago, a higher λ (e.g., 0.99) will keep older relevant context in play longer. Tuning is available via `PATCH /v1/config`. Every config change triggers an automatic eval run against your org's historical sessions before taking effect.

### Can I see which turns were pruned?

Yes. Every pruning decision is logged. The `GET /v1/sessions/:id/stats` endpoint returns a `pruning_log_id`. The pruning log contains: which turn indices were selected, which were pruned, the relevance score for each turn, and the KadaneDial parameters used. The dashboard visualizes this per session.

### How does CQ handle multi-repo or multi-project setups?

Sessions are scoped to a session ID. Within a session, context from one project cannot bleed into another. For developers working across multiple repos simultaneously, we recommend starting a new CQ session when switching projects. Cross-project memory (Tier 2/3) is scoped to the organization and surfaced only when explicitly queried — it does not auto-inject into unrelated sessions. This directly solves the "Context Bleed" problem.

### What happens to my data if I cancel?

Cancellation triggers a GDPR-compliant erasure workflow: Tier 1 is cleared immediately, Tier 2 fact records are deleted within 24 hours, Tier 3 Pinecone vectors and Neo4j nodes are deleted within 72 hours. Billing records are anonymized (session IDs replaced with salted hashes) rather than deleted, as financial records have a legal retention requirement. You can request a data export before cancellation via the dashboard.

---

## Security Questions

### How do I verify the TEE attestation?

The expected PCR values for each CQ enclave release are published in `docs/enclave-pcr-values.md` in this repository. The CQ client library verifies these automatically before establishing a ZK-Context session. To verify manually:

```bash
# Request an attestation document from the enclave
curl https://proxy.startum.com/v1/attestation/document

# Verify the PCR values match the published release
# Instructions: docs/SECURITY.md — "Attestation" section
```

### Does CQ see my Anthropic API key?

In local development (Phase 1 proxy), yes — your API key is in `.env` and the proxy forwards it to Anthropic. In production ZK-Context mode, the key is passed through the encrypted payload and only reconstructed inside the TEE before the API call. CQ's proxy never logs API keys. The operator dashboard shows only masked keys (`sk-ant-...xxxx`).

### Is CQ SOC 2 compliant?

Not yet. Target: SOC 2 Type II by month 12. The architecture is designed for compliance from day one — append-only billing records, no raw context storage, encrypted Tier 2/3 stores, role-based access control via Supabase RLS. The audit process begins at month 10.

### How do I report a security vulnerability?

Email `security@startum.com`. Do not open a public GitHub issue. See `SECURITY_POLICY.md` for the full responsible disclosure process and our commitment to response times.
