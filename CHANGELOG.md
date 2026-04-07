# CHANGELOG.md

All notable changes to Startum are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

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

### Technical Decisions
- Supabase (Postgres) over SQLite for local development parity
- Time-based (hours) over turn-count temporal decay
- Hybrid-local pruning for ZK-Context compatibility
- Structured fact extraction over LLM summarization

---

## Format Reference

When adding entries, use these categories:

**Added** — new features or capabilities
**Changed** — changes to existing functionality
**Deprecated** — features that will be removed in a future version
**Removed** — features removed in this version
**Fixed** — bug fixes
**Security** — security-related changes (always document these)
**Performance** — measurable performance improvements with numbers

Example entry format:

```markdown
## [0.2.0] — 2026-05-01

### Added
- KadaneDial pruner with ONNX bi-encoder (Phase 2)
- Tier 1 Hot Memory with 2-hour rolling window
- Waste dashboard at `/dashboard` with per-session token breakdown

### Changed
- Token counting now uses `@anthropic-ai/sdk` countTokens endpoint (was estimated)

### Fixed
- Session capture script crashed when Anthropic returned a streaming response

### Performance
- ONNX encoder: p99 latency reduced from 18ms to 7ms by switching to INT8 quantization

## [0.1.0] — 2026-04-15

### Added
- Phase 1 measurement proxy — Fastify server forwarding to Anthropic API
- Exact token counting per turn using Anthropic SDK
- Supabase session and billing record storage
- Basic waste detection: system prompt repetition, tool output echoes
```
