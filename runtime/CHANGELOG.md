# CHANGELOG.md

All notable changes to Startum are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

<!-- Format: https://keepachangelog.com/en/1.1.0/ -->

---

## [Unreleased]

### Added
- Initial project scaffold and documentation suite
- Phase 0 session capture script (`scripts/capture-session.ts`)
- Full Supabase schema with append-only billing records
- CQ-Extended KadaneDial algorithm specification
- Three-tier memory architecture design
- ZK-Context + TEE security architecture
- Git-attestation audit engine design
- Eval framework with Tier A/B/C datasets
- Token arbitrage billing model
- Architecture Decision Records (ADRs) 0001–0007

### Changed
- Removed in-file Format Reference example block (DevOPs Session 13 hygiene fix). The block's example "Fixed: Session capture script crashed when Anthropic returned a streaming response" was misread upstream as a real defect entry — it was a documentation-format demonstration. The link to Keep-a-Changelog above is now the canonical format reference.
- Runtime npm dependencies take the non-major updates listed in issue #209: `vitest` and `@vitest/coverage-v8` 5.0.5, `@supabase/supabase-js` 2.118.0, `wrangler` 4.156.1, `supabase` 2.122.0, `prettier` 3.9.10 (which reformats two `for` headers in `src/memory/source-graph.ts`), `axios` 1.21.0, `@huggingface/transformers` 4.3.2, and the rest of that list. `@typescript-eslint` stays at 8.55 because 8.56 and later need Node 22.13. `onnxruntime-node` stays at 1.30.0, the version `@huggingface/transformers` pins exactly, because 1.31.1 would install a second native runtime of about 290 MB. Major updates stay deferred.

### Technical Decisions
- Supabase (Postgres) over SQLite for local development parity
- Time-based (hours) over turn-count temporal decay
- Hybrid-local pruning for ZK-Context compatibility
- Structured fact extraction over LLM summarization
