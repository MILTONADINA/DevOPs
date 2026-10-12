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
- Issue #264: frameworks came only from the root `package.json`. An npm, yarn or pnpm
  workspaces monorepo keeps them in its packages, so it reported no frameworks and got
  no framework-specific recommendations.

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

### REQ-2 — Dependencies of workspace packages

WHEN the root `package.json` declares `workspaces` (an array, or yarn's
`{ "packages": [...] }`) or `pnpm-workspace.yaml` lists `packages`, the analyzer SHALL
read the `dependencies` and `devDependencies` of every workspace package as well as the
root's. The same detectors (frameworks, ORMs, databases, auth) SHALL run on the merged
set, so each finding is reported once. Expanding the patterns (`analyzer/workspaces.js`)
SHALL follow these rules:

- `*` matches one folder name; `**` matches any depth up to six levels;
- a `!` pattern excludes;
- it skips `node_modules`, hidden folders, symbolic links and `..`;
- it counts at most 500 packages;
- a package whose `package.json` cannot be read is skipped.

The patterns come from the analyzed repository, so expansion SHALL stay bounded for
any input:
- matching a segment SHALL take at most time proportional to the product of the
  pattern's and the folder name's lengths (no backtracking regex);
- at most 100 patterns of at most 256 characters and 16 segments are read, and
  consecutive `**` count as one;
- includes SHALL read at most 20,000 folder entries in total, and no folder is opened
  once that budget is spent; each folder is visited at most once per segment;
- exclusions SHALL be matched against the folders found, not walked, so they hold
  however the budget ran;
- only regular files are read: a symlinked `package.json` or `pnpm-workspace.yaml` is
  ignored.

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

### AC-2

**Given** a workspaces monorepo whose root has no framework dependencies **When**
`devops analyze` runs **Then** it reports the frameworks of its packages, each once,
for all three workspace forms: npm/yarn arrays, yarn's object form and
`pnpm-workspace.yaml`. Excluded, hidden, `node_modules` and symlinked folders, `..`
patterns and unreadable `package.json` files contribute nothing. A pattern built to
make a regex backtrack matches in milliseconds. A tree larger than the read budget
stops expanding and still honours its exclusions.

**Verified by:** `tests/analyzer-workspaces.test.mjs`, test titles naming
`specs/ops/analyzer-detection.md#ac-2`.

## Out of scope

- The `migration` and `audit` states, which nothing detects yet.
- Python, Rust and Go workspaces: only the root `pyproject.toml`, `Cargo.toml` and
  `go.mod` are read.
- A repository with a `.git` but no commits; it reads as brownfield, as before.
