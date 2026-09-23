# Scoped source-related Tier-2 facts

**Scope:** `plan.md` §4f dashboard sidebar over indexed File nodes.

## REQ-1 — Match active facts to an indexed file

WHEN an operator requests related facts for a project-relative File path, THE
SYSTEM SHALL first confirm that a File node with that exact path belongs to the
request's organization. It SHALL return at most 50 unsuppressed FunctionChange
facts whose `file_path` equals that path and unsuppressed TechDecision facts
whose `domain` equals that full path. It SHALL not infer a source link from a
generic domain, a substring, or a different organization's rows.

## REQ-2 — Enforce trusted scope and path

WHILE commercial authentication is enabled, THE SYSTEM SHALL use only the API
key's organization, ignoring a supplied `org-id`. WHERE personal mode is
active, THE SYSTEM SHALL require `org-id`. IF the file parameter is empty,
absolute, contains traversal or backslashes, or exceeds 1024 characters,
THEN THE SYSTEM SHALL return HTTP 400. IF the indexed File does not exist,
THEN THE SYSTEM SHALL return HTTP 404.

## REQ-3 — Show related facts safely

WHEN a File or source Function is selected in `/dashboard/graph`, THE DASHBOARD
SHALL show returned Tier-2 changes and decisions beside its source summary.
It SHALL render fact text as text and ignore a response for a node that is no
longer selected.

## Acceptance criteria

- **AC-1:** route tests prove path rejection, missing File, and key-bound org.
- **AC-2:** a local two-organization fixture returns only active exact-path
  changes and decisions, excluding suppressed, foreign, and generic-domain
  rows.
- **AC-3:** browser behavior proves related fact text is not interpreted as
  HTML and a stale response does not replace a later node's details.

## Non-functional requirements

- **NFR-1:** at most 50 fact summaries are returned per request.
- **NFR-2:** all database reads include the trusted organization ID.

These are live read-time relations. Persistent source-to-fact graph edges and
model-derived source anchors remain separate work.
