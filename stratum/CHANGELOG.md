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

### Technical Decisions
- Supabase (Postgres) over SQLite for local development parity
- Time-based (hours) over turn-count temporal decay
- Hybrid-local pruning for ZK-Context compatibility
- Structured fact extraction over LLM summarization
