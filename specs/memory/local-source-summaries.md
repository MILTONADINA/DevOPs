# Local model source File summaries

**Spec ID:** memory/local-source-summaries  
**Status:** implementation  
**Last updated:** 2026-09-23

## REQ-1 — Opt-in File summaries

WHEN `CQ_SOURCE_SUMMARY_MODEL=local/<model>` and `CQ_LOCAL_BASE_URL` point to
an HTTP OpenAI-compatible endpoint on a literal loopback IP, THE SOURCE
INGESTOR SHALL request a one-sentence summary for each indexed File before
writing graph rows. It SHALL store a bounded accepted summary on that File
node and include it in the entity's offline embedding. WHERE the summary model
is absent, ingestion SHALL keep the existing source-derived summaries and
make no model request, even if the shared `CQ_LOCAL_BASE_URL` is set for other
features. IF the summary model is set without a valid loopback URL, THEN
ingestion SHALL fail before graph writes.

## REQ-2 — Treat source and model output as untrusted

THE INGESTOR SHALL cap source text sent to the model, mark it as untrusted
data, and instruct the local model to ignore directives in it. It SHALL
sanitize instruction-like source text and marker syntax before constructing
the request. It SHALL reject redirects, non-loopback endpoints, oversized or
invalid responses, and summaries with instruction-like directives, URLs, markup, or control
characters. IF any File summary fails validation, THEN ingestion SHALL fail
before changing graph rows or vectors. It SHALL NOT call a remote provider.

## REQ-3 — Preserve existing project and tenant boundaries

THE INGESTOR SHALL continue to require the project-bound source subtree,
existing organization UUID, and project-local Compose API. Only File summaries
may be replaced by this model path; Function summaries and graph edges SHALL
retain their source-derived behavior.

## REQ-4 — Concise model completion

WHEN requesting a File summary from a local OpenAI-compatible model, THE
INGESTOR SHALL request non-thinking chat-template mode so a reasoning model
can answer within the bounded token budget. IF the provider explicitly reports
a truncated completion, THEN the ingestor SHALL reject it before graph writes.
It SHALL validate only the final answer text as a File summary.

## REQ-5 — Render persisted summary under authenticated scope

WHEN a generated File summary has been persisted for a disposable organization,
THE LOCAL VERIFIER SHALL open the graph dashboard in real Chrome, authenticate
with that organization's API key, select the File, and observe the exact stored
summary as text. Its guided tour SHALL include the stored summaries in
dependency order. A second organization's graph row SHALL remain absent from
the authenticated view even if its organization ID appears in the page URL. The
verifier SHALL remove both organizations and their graph rows afterward.

## Acceptance criteria

- A focused test first fails without the summarizer, then proves summary
  replacement, bounded prompt/output, no call when disabled, and rejection of
  hostile or malformed output.
- A loopback HTTP fixture verifies the real transport refuses non-loopback
  addresses and redirects and never sends unsanitized instruction text.
- A disposable local Compose fixture proves an accepted model File summary
  and its updated embedding are stored under the bound organization.
- A real local text-model run demonstrates factual one-sentence summaries
  from JS/TS, Rust, and Python source samples without changing graph rows.
- A disposable local Compose run with a real local text model persists accepted
  File summaries and embeddings through the actual ingestor, preserves
  source-derived Function summaries, and removes its fixture rows.
- A real Chrome run over that same local Compose fixture displays the stored
  File summary in the sidebar and guided tour, excludes a second organization's
  File, and leaves no fixture graph/vector rows after cleanup.

This gate verifies the local integration and output policy. The real local
model sample covers 11 selected Files; representative accuracy across arbitrary
source remains unverified.
