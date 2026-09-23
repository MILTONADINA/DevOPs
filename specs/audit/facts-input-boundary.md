# Audit facts input boundary

**Scope:** `plan.md` §5a Tier-1 audit runner and AGENTS.md Principle 7.

## REQ-1 — Project-local facts

WHEN `audit:repo --facts` is given a path, THE SYSTEM SHALL read it only if the
path is a regular file inside this DevOPs project root. It SHALL reject paths
outside the root and paths containing symbolic links before reading contents.

## REQ-2 — Secret exclusion

WHEN any path component names an `.env` file or a `*.pem` or `*.key` file, THE
SYSTEM SHALL reject it before reading contents. A rejected input SHALL yield a
nonzero command exit and SHALL NOT trigger audit persistence.

## Acceptance criteria

- **AC-1:** a regular project-local JSON path resolves successfully.
- **AC-2:** parent traversal and symlink paths are rejected before a read.
- **AC-3:** `.env`, `*.pem`, and `*.key` paths are rejected before a read.
