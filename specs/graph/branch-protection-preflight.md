# Detect drift in the merge gate before a sprint

**Status**: draft

**Scope:** MR-8 / masterpiece REQ-M13, under the owner's standing roadmap
continuation. Roadmap Decision 2 requires zero approving reviews, because
agents share the owner's identity; that decision overrides the older M13 and
MR-8 wording requiring one review. This slice reads protection settings and
never applies them. It does not approve the whole masterpiece draft.

The main protection response observed on 2026-10-03 requires `validate`,
`runtime-test`, `setup-linux`, `gitleaks`, `semgrep` and `dependency-audit`,
with strict status checks, administrator enforcement and zero approving reviews.

## REQ-1 — Commit the required contexts

THE REPOSITORY SHALL keep `governance/required-checks.yml` as a JSON-compatible
YAML object with exactly one `contexts` field containing a nonempty array of
unique, nonempty, trimmed context names. Its initial names SHALL be the six
contexts above. DeepTeam (`deepteam`) and `Claude semantic security review`
SHALL NOT be configured as required: their skips do not establish an executed
review. Missing, unreadable or malformed configuration SHALL fail the check.
The committed file is the intended context policy; protecting policy files
against agent edits remains MR-4. Policy and allowlist reads for this check
SHALL resolve inside the project root; a redirect outside SHALL fail before
reading that target.

## REQ-2 — Read only the current GitHub origin's main protection

WHEN Git resolves the current project root, THE PREFLIGHT SHALL add
`branch.protection`. The protection check SHALL independently bind its Git
root and origin lookup to this project with inherited `GIT_*` routing/config
overrides removed, so a different `GIT_DIR` cannot supply the origin. It SHALL
resolve owner/repository from `origin`, supporting
ordinary `https://github.com/OWNER/REPO[.git]`,
`git@github.com:OWNER/REPO[.git]` and
`ssh://git@github.com/OWNER/REPO[.git]` forms only. It SHALL reject credentials
in HTTPS URLs, ports, query strings, fragments, extra path segments and invalid
owner/repository segments before making an API request. Owner/repository
segments SHALL contain only ASCII letters, digits, underscores, hyphens and
periods, and SHALL NOT be `.` or `..`.

IF the project allowlist does not contain the exact `api.github.com` entry,
THEN the check SHALL fail without invoking `gh`. WHEN its prerequisites pass,
THE CHECK SHALL call the owner's local `gh api --hostname github.com` for the
explicit `repos/OWNER/REPO/branches/main/protection` resource, using argv rather
than a shell, with a bounded timeout. Ambient `GH_HOST` SHALL NOT change the
requested host. It SHALL NOT infer a repository from the current directory,
follow an origin to another host, or make a mutating API call.

WHEN the original `git.runs` check fails, THE CHECK SHALL be recorded as
`skipped` and SHALL NOT call `gh`; that existing failure keeps the whole
preflight non-ready. IF the original check passed but the independent sanitized
root binding fails or resolves elsewhere, THEN `branch.protection` SHALL fail
with `needs_human`, without calling `gh`.

## REQ-3 — Fail closed on missing protections or unreadable responses

WHEN the response is a valid JSON object, THE CHECK SHALL pass only if:

- `required_status_checks.contexts` is an array of nonempty strings containing
  every configured context;
- `required_status_checks.strict` is exactly `true`;
- `enforce_admins.enabled` is exactly `true`;
- `required_pull_request_reviews.required_approving_review_count` is exactly
  the integer `0`, in accordance with Decision 2.

Additional ordinary required contexts MAY remain; neither unfunded review
context named in REQ-1 SHALL appear in the actual required list. Missing/null
objects, malformed field types, invalid JSON, a missing `gh`, nonzero API exit,
signal or timeout SHALL produce a failed `branch.protection` check. Failure
SHALL result in `needs_human` and exit 20 under the existing preflight protocol;
it SHALL NOT be silently skipped, repaired or converted into `ready`.

Evidence SHALL identify the failed protection or prerequisite without dumping
raw API output, credentials or tool environment. Success SHALL identify the
checked repository and branch. Neither normal nor `--check-only` mode SHALL
write GitHub protection settings. Existing preflight checks and remediation
behavior SHALL be preserved.

## Acceptance criteria

### AC-1 (REQ-1..3)

**Given** an isolated copied preflight and owned Git/gh stubs **When** the
response has all six contexts, strict/admin enforcement and reviews zero
**Then** `branch.protection` passes and the otherwise healthy preflight is
`ready`; every missing context, weakened/malformed required field, protected
review count other than zero, API failure and malformed response instead
produces `needs_human` with exit 20 and a specific check diagnostic. A larger
ordinary context set remains valid; either unfunded context is rejected.

### AC-2 (REQ-1, REQ-2)

**Given** missing/malformed policy, a missing API allowlist entry or an invalid
origin **When** preflight runs **Then** it records the failed check without
calling gh. Each supported origin form produces the same explicit GitHub
resource; unrelated ambient GH_HOST and GIT_* overrides cannot reroute it.
Policy/allowlist redirects outside the project are refused before gh runs. A failed original Git root
check records the protection check as skipped and never invokes gh; a failed
sanitized rebind after the original passed instead records failure.

### AC-3 (REQ-3)

**Given** all existing preflight repair, halt, blocked-marker and readHead
acceptance cases **When** their fixtures supply owned gh responses and the new
policy prerequisites **Then** all original assertions still hold, without new
authentication or live API dependencies. New unit fixtures SHALL NOT call the
real GitHub API, touch operator credentials or weaken existing assertions.

### AC-4 (REQ-2, REQ-3)

**Given** this repository and the owner's existing authenticated gh **When**
the read-only main protection endpoint is queried **Then** it returns the
configured contexts and owner-required settings. Preserve the response as
bounded evidence; do not mutate settings or repeat an unchanged successful GET.

**Enforced by:** `scripts/graph-preflight.mjs`, the committed context policy
and the existing preflight status gate before a sprint launch.

**Falsified by:** a healthy preflight reporting ready with a missing required
context, a 404 protection response, non-strict status checks or disabled
administrator enforcement; or an invalid origin issuing a gh API request.
