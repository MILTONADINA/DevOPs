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

## Acceptance criteria

- A focused test first fails without the summarizer, then proves summary
  replacement, bounded prompt/output, no call when disabled, and rejection of
  hostile or malformed output.
- A loopback HTTP fixture verifies the real transport refuses non-loopback
  addresses and redirects and never sends unsanitized instruction text.
- A disposable local Compose fixture proves an accepted model File summary
  and its updated embedding are stored under the bound organization.

This gate verifies the local integration and output policy. Broad summary
quality requires a separately recorded run against a real local text model.
