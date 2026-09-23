# Python source graph ingestion

**Spec ID:** memory/source-graph-python  
**Status:** implementation  
**Last updated:** 2026-09-23

## REQ-1 — Index local Python source

WHEN a project-bound ingestion subtree contains `.py` files, THE SYSTEM SHALL
create File nodes, Function nodes for top-level `def` and `async def`, and
DECLARES edges. It SHALL create directed DEPENDS_ON edges only when a top-level
single-line `import` or `from ... import` resolves to another known project-local `.py`
file or package `__init__.py`. Relative leading dots SHALL resolve from the
importer's package directory; bare names SHALL resolve only to known sibling
files. Each node SHALL retain its project-relative path and a bounded
source-derived summary.

## REQ-2 — Ignore non-code decoys

THE SYSTEM SHALL ignore apparent declarations and imports inside Python line
comments, single or double quoted strings, triple quoted strings, and
indented class or function bodies. It SHALL retain the trusted project-root,
local Compose, organization, file-size, and symlink boundaries from
`source-graph-ingestion.md`.

## REQ-3 — Reingest without duplicates

WHEN the same Python subtree is ingested again, THE SYSTEM SHALL reuse its
nodes and edges and replace entity embeddings with the offline local model.

## Acceptance criteria

- Parser tests first fail without Python support, then prove top-level sync
  and async functions, one sibling and one relative import, and decoy
  exclusion. They also recognize `model_callback` in the repository's actual
  Python fixture.
- A local Compose fixture ingests two Python files twice with stable node,
  edge, and vector counts; the new rows remain in the bound organization.

This parser covers the named syntax; dynamic imports, conditional import
execution, and Python runtime resolution are outside this static graph.
Model-generated source summaries remain a separate gate in `plan.md` §4f.
