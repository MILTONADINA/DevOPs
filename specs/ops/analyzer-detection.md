# What `devops analyze` detects

**Status**: approved (owner, 2026-10-11, in chat: fix issues #263–#267 directly, one pull request each)
**Spec ID**: ops/analyzer-detection
**Owner**: Milton Adina

## Scope

`devops analyze` (`analyzer/scan.ts`) reads a project and writes `.workflow/profile.yml`.
`devops init` then installs from that profile. This spec covers what the analyzer
detects and from where. It grows one requirement per fixed detection gap. It does not
cover what the profile recommends.

## Problem

Running the published 0.4.0 against a real repository found these gaps:

- Issue #263: the project state came from `git rev-list --count HEAD`.
  - That ran in the process's working directory, not the analyzed project.
  - A shallow clone, which is CI's default checkout, has one commit, so a mature project
    read as greenfield, and `init` then set the greenfield mode and lifecycle.

## Requirements

### REQ-1 — Project state from the project's own history

`analyzer/project-state.js` `detectState` SHALL run every git command in the analyzed
project, never in the process's working directory. It returns:

- **greenfield** when the project has no `.git`, or when its full history has fewer than
  five commits;
- **hotfix** when `docs/incidents` holds a file named for the current year;
- **brownfield** otherwise.

WHEN `git rev-parse --is-shallow-repository` prints `true`, the commit count SHALL NOT
be read as the project's age. The state is decided as if the history were long, and
`devops analyze` prints the reason after the state. A failing git call SHALL NOT fail
the analysis.

## Acceptance criteria

### AC-1

**Given** a project **When** its state is detected **Then**:
- every git call runs in that project;
- no `.git`, or fewer than five commits in full history, gives greenfield;
- a shallow clone with one commit gives brownfield, with a note that says why;
- a failing git gives brownfield;
- a current-year incident gives hotfix.

**Verified by:** `tests/analyzer-state.test.mjs`, test titles naming
`specs/ops/analyzer-detection.md#ac-1`.

## Out of scope

- The `migration` and `audit` states, which nothing detects yet.
- A repository with a `.git` but no commits; it reads as brownfield, as before.
