# Historical Drift dashboard alert

**Scope:** `plan.md` §5c and `stratum/docs/AUDIT_ENGINE.md` Historical Drift Alerts.

## REQ-1 — Scoped alert

WHEN an operator opens `/dashboard` with a valid CQ API key, THE SYSTEM SHALL
request unacknowledged conflicts from `/v1/memory/conflicts` using that key in
the Authorization header. It SHALL display the conflict details in a red
Historical Drift banner and refresh while the page is visible. In personal
mode, an explicit `org-id` MAY be used as the existing API allows.

## REQ-2 — Safe page

WHILE rendering dashboard and conflict data, THE SYSTEM SHALL insert dynamic
values as text, never as HTML. It SHALL keep the API key out of URLs and the
rendered DOM, and SHALL apply the same framing and connection restrictions as
the existing billing dashboard. WHEN commercial authentication is enabled,
THE SYSTEM SHALL refuse the legacy unscoped `/dashboard/api` capture summary.

## REQ-3 — Gate honesty

WHEN the dashboard path is added, THE SYSTEM SHALL leave the v0.6 <5-second
live alert gate open until insertion-to-render timing is measured on a deployed
instance. A browser refresh period alone is not proof of that gate.

WHILE the page is visible and an audit-status request is pending, THE SYSTEM
SHALL continue polling the conflict API at its normal interval so status
lookup latency cannot stop Historical Drift alert refresh.

## REQ-4 — Local browser timing evidence

WHEN a conflict is added to an injected organization-scoped store while the
local dashboard is visible, THE LOCAL VERIFIER SHALL measure elapsed wall time
until real Chrome renders that conflict's text through the scoped API. It SHALL fail
if rendering takes 5 seconds or longer or if the conflict appears before
insertion. This local measurement SHALL NOT close the deployed ship gate in
REQ-3.

## Acceptance criteria

- **AC-1:** the page fetches the protected conflict API with a Bearer header;
  its existing tenant-scoping test remains green.
- **AC-2:** adversarial strings in session or conflict data cannot create HTML
  elements during rendering.
- **AC-3:** no conflict text is fetched before a key or personal org is supplied;
  the page shows a visible error on unauthorized or failed requests.
- **AC-4:** commercial mode does not expose cross-tenant captured-session
  summaries through `/dashboard/api`; personal mode retains its local report.
- **AC-5:** an unresolved audit-status request does not block the next visible
  conflict poll.
- **AC-6:** a real Chrome run observes an initially empty alert banner, adds
  one scoped conflict to the injected store, and reports time from that store
  update to rendering under 5 seconds.
