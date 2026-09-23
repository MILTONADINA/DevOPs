# Rust source graph ingestion

**Spec ID:** memory/source-graph-rust  
**Status:** implementation  
**Last updated:** 2026-09-23

## REQ-1 — Index project-local Rust source

WHEN a project-bound ingestion subtree contains `.rs` files, THE SYSTEM SHALL
create File nodes, top-level named `fn` and `pub fn` Function nodes, DECLARES
edges, and DEPENDS_ON edges for top-level `mod name;` declarations that resolve
to a known sibling `name.rs` or `name/mod.rs` file. It SHALL store a
project-relative path and a bounded source-derived summary for each node.

## REQ-2 — Respect syntax and boundaries

THE SYSTEM SHALL ignore apparent declarations in Rust line comments, nested
block comments, strings, raw strings, and function bodies. It SHALL skip
symbolic links, hidden and generated directories, and files over the existing
ingestion size limit. The organization and local Compose boundaries from
`source-graph-ingestion.md` SHALL remain in force.

## REQ-3 — Reingest without duplicates

WHEN the same Rust subtree is ingested again, THE SYSTEM SHALL reuse its
File/Function nodes and edges and replace entity embeddings using the offline
project-local model.

## Acceptance criteria

- A parser test first fails on Rust input, then proves two File nodes, two
  Function nodes, two DECLARES edges, and one directed module dependency,
  excluding comment/string/body decoys.
- A local Compose round-trip ingests that Rust fixture twice without
  duplicate nodes, edges, or vectors.
- The repository's `stratum/rust/hot-path/src/lib.rs` yields its real
  `sha256_hex` Function node in a parser check.

This covers the Rust syntax above. Other languages and model-generated source
summaries remain separately tracked in `plan.md` §4f.
