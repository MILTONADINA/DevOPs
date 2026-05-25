/**
 * Tier 3 — Cold Memory (Neo4j Knowledge Graph)
 *
 * Stores structured relationships between entities for deterministic queries.
 * Node types: Function, Commit, Decision, Developer, Policy, Project.
 * Edge types: DEPRECATED_BY, REFERENCED_IN, SUPERCEDES, AUTHORED, MODIFIES, GOVERNS.
 *
 * Enables queries like "What is the current status of function X?"
 * at ~50 tokens vs. 50,000 tokens of raw history.
 */

// TODO: Implement Neo4j adapter (Phase 3)
