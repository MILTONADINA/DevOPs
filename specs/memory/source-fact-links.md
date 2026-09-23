# Durable source-to-fact graph links

**Scope:** `plan.md` §4f links between indexed source Files and active Tier-2
FunctionChange and TechDecision facts. The existing graph sidebar is the reader.

## REQ-1 — Persist only exact scoped links

WHEN an active FunctionChange has `file_path` equal to an indexed File's full
project-relative `name` and `file_path`, THE DATABASE SHALL persist one link
from that File to the fact within the same organization. WHEN an active
TechDecision has `domain` equal to the same full indexed path, THE DATABASE
SHALL do likewise. It SHALL not create links for a generic domain, suppressed
fact, missing File, or a File in another organization. Each link SHALL have
foreign keys to its owning File and typed fact, and exactly one fact type.

## REQ-2 — Keep links current across write order and lifecycle

WHEN the fact is inserted before the File or the File before the fact, THE
DATABASE SHALL create the same unique link once both exist. WHEN a fact is
suppressed, deleted, moved to a different path, or restored, THE DATABASE
SHALL remove or update its link in the same transaction. WHEN a File is
deleted or changes its path, THE DATABASE SHALL remove stale links. Repeated
matching writes SHALL not duplicate links. Existing active exact matches
SHALL be backfilled by the migration.

## REQ-3 — Read durable links with active-fact defense

WHEN the related-facts API reads an indexed File, THE SYSTEM SHALL derive its
at most 50 summaries from persistent links, ordered newest first. It SHALL
still filter the backing fact's organization and `is_suppressed=false` state
so a stale or invalid link cannot disclose a suppressed or foreign fact.
Commercial API-key organization scope and the existing 400/404 behavior SHALL
remain in force. Only the service role SHALL read or mutate links through the
database API.

## Acceptance criteria

- **AC-1:** a local two-organization fixture proves exact-path own-org links,
  suppressed/generic exclusion, both insert orders, and no duplicate on retry.
- **AC-2:** direct fact suppression, restoration, path change, deletion, and
  File deletion remove or restore the right links; API results follow them.
- **AC-3:** migration backfill and database constraints reject a cross-org
  File/fact reference and a link with both or neither fact ID.
- **AC-4:** the existing related-facts route and real-browser checks pass with
  the durable read path.
