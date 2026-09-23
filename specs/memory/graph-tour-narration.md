# Source graph tour narration

**Spec ID:** memory/graph-tour-narration  
**Status:** implementation  
**Last updated:** 2026-09-23

## REQ-1 — Explain each tour step

WHEN the operator starts or advances the dependency tour, THE DASHBOARD SHALL
show a short plain-English paragraph naming the current File, using its
source summary when present, and explaining the File's direct `DEPENDS_ON`
relationships to other Files in the loaded tour. The paragraph SHALL update
with Previous and Next navigation. WHEN a summary or relationship is absent,
THE DASHBOARD SHALL say so without inventing source behavior.

## REQ-2 — Bound and safely render graph data

THE DASHBOARD SHALL generate narration only from the organization-scoped File
and dependency pages already loaded for the tour. It SHALL bound names,
summaries, and relationship lists in the paragraph and render them as text.
WHEN a dependency cycle affects the ordering, THE DASHBOARD SHALL disclose
that limitation in the narration.

## Acceptance criteria

- A browser behavior test first fails without narration, then proves each
  step describes the correct File and direct dependency direction, updates on
  Previous/Next, and renders hostile source metadata as literal text.
- A real Chrome check proves dependency-first navigation displays a paragraph
  for both steps and no source text is interpreted as HTML.

The narration is deterministic graph-derived prose. Model-generated source
summaries are a separate gate in `plan.md` §4f.
