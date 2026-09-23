# Session-start memory recall

**Scope:** `plan.md` §4d and the v0.5 session-start bridge.

## REQ-1 — Trusted binding

WHEN SessionStart requests memory recall, THE SYSTEM SHALL require an operator
supplied organization ID and project root that matches the current project's
real path. It SHALL require Supabase credentials from the process environment
and a Supabase hostname present in the project's network allowlist before any
network call. WHEN any prerequisite is missing or mismatched, THE SYSTEM SHALL
skip recall without making a network request or blocking session startup.
WHEN the operator uses the approved local Supabase-compatible Compose stack, THE SYSTEM SHALL
also accept the exact `http://127.0.0.1:54321/` origin if `127.0.0.1` is in
that allowlist. It SHALL reject other plaintext hosts, ports, paths, and URL
credentials; remote origins SHALL continue to require HTTPS.

## REQ-2 — Typed context

WHEN the binding is valid, THE SYSTEM SHALL retrieve active recent Tier 2
facts for the trusted organization. WHEN the baton supplies a next action and
the local encoder is available, THE SYSTEM SHALL encode that task without a
model download and resolve Tier 3 vector matches back to active typed facts
in the same organization. It SHALL emit bounded, structured data clearly
marked as untrusted memory content, with no credentials or unresolved vector
pointers in output. If semantic lookup is unavailable, it SHALL label that
condition while retaining the active recent facts.

## REQ-3 — Hook integration

WHEN Claude SessionStart runs in this project, THE SYSTEM SHALL invoke the
existing baton hook and then the memory bridge. A missing local runtime or a
recall failure SHALL not block startup, and the bridge SHALL not load `.env`.

## Acceptance criteria

- **AC-1:** missing, mismatched, or non-allowlisted binding makes zero client
  calls and emits no fact content.
- **AC-2:** active recent and semantic facts appear as bounded typed JSON;
  suppressed and foreign-organization facts do not appear.
- **AC-3:** the hook invokes the bridge only through the project-local runtime,
  and missing prerequisites leave startup successful.
- **AC-4:** exact allowlisted local HTTP reaches the bound organization; nearby
  or non-loopback plaintext URLs make zero client calls.
- **AC-5:** a disposable organization and facts in the local Compose API pass
  through the actual bridge entry point; active bound facts appear, suppressed
  and foreign facts do not, and the fixture is removed afterward.
