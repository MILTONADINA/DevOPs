# npm package release

**Status**: approved (owner, 2026-10-11, in chat: "get this repo ready to deploy an npm package"; first release 0.4.0, published from CI on a version tag, tsx shipped as a dependency, internal records trimmed and only what is ready shipped)
**Spec ID**: release/npm-package
**Owner**: Milton Adina
**Amended**: 2026-10-12, for issue #267 (owner, in chat: fix issues #263–#267 directly). REQ-3 now writes the hook where Git runs hooks rather than always `.git/hooks`. The new REQ-8 makes `devops init` report each safety gate.

## Scope

DevOPs is distributed as the npm package `@miltonadina/devops`. A user installs it
with `npm install -g @miltonadina/devops` (or runs it with `npx`) and points it at a
project with `devops analyze` and `devops init`. This spec covers what the package
contains, how its commands find their files, and how a release is published. It does
not cover the runtime (`runtime/` stays a private package), the graph pipeline (it
still assumes this repository), or a hosted service (there is none, ADR-0025).

## Problem

Before this spec the package could not be installed and used:

- `devops` and the installer read `~/DevOPs` (a fixed folder in the home directory)
  unless `DEVOPS_ROOT` was set, so an npm install ran against a folder that did not
  exist.
- `devops-analyze` and `devops-install` worked out their folder from the
  `node_modules/.bin` symlink and failed; `devops-install` copied `node_modules` into
  `~/DevOPs`.
- `devops verify` and `devops analyze` ran TypeScript through a `tsx` found on PATH,
  which a user does not have: it was only a development dependency.
- The generated git pre-commit hook pointed at `~/DevOPs`, ran gitleaks without
  `--redact`, and replaced any existing hook.
- The package shipped this repository's own records (handoff notes, the
  launch-readiness log, research notes, test floors, the claim ledger) and CI-only
  scripts.
- There was no publish workflow.

## Requirements

### REQ-1 — One root

The `devops` and `devops-analyze` commands, `scripts/init-project.sh` and
`analyzer/install.ts` SHALL read their files from `DEVOPS_ROOT` when it is set and not
blank, and otherwise from the package or checkout they belong to. They SHALL find it
through any number of symlinks (npm installs each command as a symlink). No default
SHALL depend on `HOME`.

### REQ-2 — The commands run where the package is installed

`devops analyze`, `devops-analyze`, `devops init` and `devops verify` SHALL run their
TypeScript with the current Node and the `tsx` the package depends on, resolved from
the package, never one looked up on PATH. `tsx` SHALL be a runtime dependency. An
unknown command, including an inherited object key such as `toString`, SHALL exit 1
with an error.

### REQ-3 — The generated pre-commit hook

WHEN `devops init` runs in a git repository, IT SHALL write `pre-commit` into the
folder `git rev-parse --git-path hooks` names. That folder can belong to a linked
worktree's repository or to a submodule's git dir.

- It SHALL write the hook only if no hook exists there or the existing one carries the
  DevOPs marker line; otherwise it SHALL leave the existing hook unchanged and say so.
- WHEN `core.hooksPath` is set, IT SHALL write no hook, because that folder is the
  project's own or shared, and SHALL say which checks to add there by hand.
- The hook SHALL scan the staged change with `gitleaks git --pre-commit --staged
  --redact` and SHALL validate local claims with the `devops` command, not with a path
  under `~/DevOPs`.
- IF a check's tool is missing (`gitleaks` for the scan; `devops` on PATH or in
  `node_modules/.bin` for claims, checked only when `.workflow/proofs/*.yml` exists),
  THEN the hook SHALL stop the commit (exit 1) with a message naming the tool and the
  skip variable, unless that variable (`DEVOPS_SKIP_SECRET_SCAN=1` or
  `DEVOPS_SKIP_CLAIM_CHECK=1`) is set, in which case it SHALL say the check was
  skipped. It SHALL NOT skip a check in silence (#348).
- WHEN `--dry-run` is given, `devops init` SHALL write nothing.

### REQ-4 — Package contents

The package SHALL contain the contract (`AGENTS.md` and the consumer `templates/claude-md/CLAUDE_TEMPLATE.md`), the constitution,
the skills with their signatures and manifest, the hooks and the companion they need,
the subagents, the slash commands, the analyzer, the verification tools, the
templates, the user documentation and the files those reference. It SHALL NOT contain
this repository's own records or tooling: `.workflow/`, `specs/`, `tests/`,
`runtime/`, the handoff notes, the launch-readiness log, `governance/graph/`,
`governance/test-floors.json`, CI-only scripts, or the graph pipeline's pieces (its
session-start preflight hook and the `/sprint`, `/sprint-approve`, `/graph-halt` and
`/graph-resume` commands), which still assume this repository.

### REQ-5 — Publish metadata

`package.json` SHALL publish with public access and a provenance attestation, and
SHALL name the license, the repository, the homepage and the issue tracker. The
version SHALL be the same in `package.json`, `.claude-plugin/plugin.json` and
`governance/VERSION.md` (specs/ops/repo-hygiene.md REQ-2).

### REQ-6 — Every pull request installs the package

CI SHALL pack the package, install the tarball into an empty project with runtime
dependencies only, an empty HOME and no `DEVOPS_ROOT`, and run `devops version`,
`devops help`, `devops-analyze` and `devops init --dry-run`. The last SHALL fail when a
shipped skill differs from its signed manifest entry. CI SHALL check that the tarball
holds the required files and none of REQ-4's excluded paths.

### REQ-7 — Release from a version tag

WHEN a tag `vX.Y.Z` is pushed, THE RELEASE WORKFLOW SHALL publish version X.Y.Z only
after it has checked that:

- the tag points to a commit on `main`;
- the tag matches the `package.json` version;
- `CHANGELOG.md` has a `## [X.Y.Z]` section;
- the root tests and REQ-6's install check pass;
- every skill in the manifest verifies with `cosign` against the `release-sign.yml`
  signing identity.

The publish step SHALL run in a GitHub environment that a person approves, and SHALL
authenticate with npm trusted publishing (OIDC), or with an `NPM_TOKEN` environment
secret for the first release, before the package exists on npm.

### REQ-8 — `devops init` reports each safety gate

`devops init` SHALL end with a "Safety gates" summary that leaves no gate's state
implicit:

- **pre-commit gate:** installed and where, adding "shared by every worktree of this
  repository" for a linked worktree; or not installed and why. The reasons are: git is
  missing, the folder is not a repository, `core.hooksPath` is set, another tool's hook
  is there, or it was a dry run.
- **Claude Code hooks:** how many hook scripts were copied to `.claude/hooks/`, and,
  by name, those that neither `.claude/settings.json` nor
  `.claude/settings.local.json` references, so Claude Code does not run them, with
  where wiring is described.
- **secret scan** and **claim check:** when the hook is installed, whether each check
  runs or cannot run because its tool is missing, naming the tool and the skip
  variable (#348).

### REQ-9 — `devops-analyze` answers its flags before it scans

When `devops-analyze` receives `--help` or `-h`, `devops-analyze` SHALL print its usage and exit 0.
When it receives `--version` or `-v`, it SHALL print the package version and exit 0.
When `devops-analyze` receives any argument that begins with `-` other than those four, even alongside them, it SHALL exit non-zero with
a one-line message on stderr that names the argument and points to `--help`. In all
three cases it SHALL NOT scan or write `.workflow/`.

### REQ-10 — Init's agent bootstrap instructions are usable

WHEN `devops init` generates `AGENTS.md` and prints its first steps, IT SHALL
reference the live package's constitution, without copying constitution files.
WHERE `DEVOPS_ROOT` (or the installed package root) is inside the target project,
IT SHALL compute project-relative paths at init time and render forward slashes.
WHERE the package is outside the target project (including npx/global installs),
IT SHALL identify `@miltonadina/devops` and use package-relative
`constitution/PRINCIPLES.md`, `constitution/ANTIPATTERNS.md` and
`constitution/LOOP.md`, never machine-specific absolute constitution paths.

WHEN init prints the first-spec step, IT SHALL tell the user to create `specs/`
and write the first spec there, rather than imply the folder already exists.

WHEN init runs, IT SHALL append the exact lines `AGENTS.override.md`,
`.workflow/state/install-manifest.json` and `.workflow/state/originals/` to the
target's `.gitignore`, each only if absent (#390), creating the file if necessary, even outside git. IT SHALL
preserve existing content and line endings and SHALL NOT duplicate an existing
entry. WHEN `--dry-run` is given, IT SHALL write nothing and report a needed entry
as an addition it would make.

WHEN analyze runs, IT SHALL append `.workflow/state/install-manifest.json` and
`.workflow/state/originals/` the same way and SHALL record the write, so uninstall
restores the project's `.gitignore` or removes one DevOPs created. IF the
`.gitignore` is a symlink, analyze SHALL refuse with exit 1, as init does (#391).

### REQ-11 — Init installs a consumer CLAUDE.md, not this repository's own

WHEN `devops init` installs `CLAUDE.md`, IT SHALL write a short adapter from the
package's `templates/claude-md/CLAUDE_TEMPLATE.md`, never this repository's own
development `CLAUDE.md`. The adapter SHALL name only files that init installs or the
package ships, at their real location (the constitution references follow REQ-10), and
SHALL describe only hooks and settings that init installs in a consumer project. It SHALL
carry no internal history, owner names or dates, and SHALL point to `AGENTS.override.md`
for per-project rules. IF `CLAUDE.md` already exists, IT SHALL NOT overwrite it. WHEN
`--dry-run` is given, IT SHALL write nothing. The published package SHALL NOT ship this
repository's own `CLAUDE.md`.

### REQ-12 — The support and end-of-life policy is published

`docs/RELEASING.md` SHALL have a "Support and end-of-life" section stating that the
latest minor is supported, that the previous minor receives security fixes only for 90
days after the latest minor is released, and that the Node.js floor changes only in a
minor release with a CHANGELOG note. The Node.js floor it states SHALL equal
`engines.node` in `package.json`, and `SECURITY.md` SHALL link to the section.

### REQ-13 — The tarball is reproducible

WHEN CI's `package-smoke` job or the release workflow's `verify` job runs, THE
PIPELINE SHALL pack the package twice from the same commit into separate temporary
directories and compare the tarball sha256 and each entry's path and sha256. IF they
differ, THEN it SHALL fail and print the differing entries.

### REQ-14 — Init's printed steps name only files that exist

WHEN `devops init` finishes, THE SYSTEM SHALL name in its "Next steps" and "First steps
in the agent" only files that exist in the project or in the installed package, naming a
package file by its path from the project when the package is inside it and otherwise as
`` `<path>` in the `@miltonadina/devops` package ``. THE SYSTEM SHALL NOT tell the user to
run a slash command that init did not install (#352).

### REQ-15 — Init and analyze record what they write

WHEN `devops analyze` or `devops init` (not a dry run) writes a file in the project, or
the DevOPs pre-commit hook, THE SYSTEM SHALL record it in
`.workflow/state/install-manifest.json` (`schema_version: 1`) with the sha256 of what it
wrote, and the folders it created. WHEN it first writes a file that already existed, THE
SYSTEM SHALL copy the existing bytes to `.workflow/state/originals/<path>` and record their
sha256 as the file's `original`, and SHALL NOT change that `original` on a later run. IF
the manifest has another `schema_version`, another key set, or a path that is not one
DevOPs writes (`AGENTS.md`, `CLAUDE.md`, `.gitignore`, the hook, or a path under
`.claude/skills/`, `.claude/hooks/`, `.claude/agents/` or `.workflow/`), or an `original`
copy that is not its own `originals/<path>`, THEN THE SYSTEM SHALL refuse to run and change
nothing. WHEN it starts the manifest in a project that already has
`.workflow/state/install.log` (an earlier DevOPs installed there), THE SYSTEM SHALL set
`adopted: true` and say so once, because an `original` recorded there may be that earlier
DevOPs's copy. Backups (REQ-F11) and the `originals/` copies are DevOPs's own records and
are not themselves recorded. The `.mcp.json` entry and the Agile Graph pin that linking
writes are not recorded yet (#353).

### REQ-16 — Uninstall removes what was recorded

WHEN `devops uninstall` runs in a project with an install manifest (REQ-15), THE SYSTEM
SHALL remove each recorded file DevOPs created whose bytes still have the recorded
`written` sha256, SHALL put back each recorded original whose file still holds what DevOPs
wrote (or is gone) and whose copy still has the recorded `original` sha256, SHALL remove
the pre-commit hook only while it carries the DevOPs marker and its recorded bytes, and
SHALL remove the folders DevOPs created that are then empty. IF a recorded file was edited,
is a symlink or not a regular file, has an unconfirmed write, or has an original copy that
is missing or changed, or the manifest is `adopted` and the file has a recorded original,
THEN THE SYSTEM SHALL leave that file unchanged, name it and the reason, and keep its
entry in the manifest. IF Git tracks the manifest or `.workflow/state/originals/`, THEN THE
SYSTEM SHALL refuse with exit 1 and change nothing, because that record came with the
repository rather than from an install on this machine. THE SYSTEM SHALL look for the hook
in the repository's own hooks folder, where init writes it, whatever `core.hooksPath` says
later. THE SYSTEM SHALL drop each file's entry from the manifest as soon as it is handled,
before deleting its original copy, so that an uninstall that stops part-way finishes when
run again. WHEN run with `--dry-run`, THE SYSTEM SHALL report the same plan, including the
folders it would remove, and change nothing. WHEN the project has no manifest, THE SYSTEM
SHALL change nothing and say so. A file edited in the instant between the check and the
removal is not protected, and the empty `hooks` folder init may create inside Git's own
folder is left.

### REQ-17 — The installed AGENTS.md names paths the reader can open

WHEN `devops init` installs `AGENTS.md`, THE SYSTEM SHALL rewrite each backticked path that
names a file or folder the package ships (by `package.json` `files`), including a pattern
such as `lifecycle/<phase>/PHASE.md` whose fixed part ships, the way REQ-10 names the
constitution: by its path from the project when the package is inside it, else as
`<path>` in the `@miltonadina/devops` package. THE SYSTEM SHALL leave paths under
`.workflow/`, which `AGENTS.md` states are project state created when first needed, and
the project's own `specs/`, `AGENTS.override.md` and `package.json`, as written (#380).

## Acceptance criteria

### AC-1

**Given** an install with no `DEVOPS_ROOT` and a HOME that holds nothing **When**
`devops version` and `devops help` run, directly or through a `node_modules/.bin`-style
symlink **Then** they print the package's version and its own folder as the root; a
blank `DEVOPS_ROOT` means the package; an unknown command, including `toString`, exits
1.

**Verified by:** `tests/npm-package.test.mjs`, test titles naming
`specs/release/npm-package.md#ac-1`.

### AC-2

**Given** the same install **When** `devops-analyze` runs in a project **Then** it
writes `.workflow/profile.yml`, using the package's own `tsx`, which is a runtime
dependency and not a development one.

**Verified by:** `tests/npm-package.test.mjs` (`#ac-2`) and CI's `package-smoke` job.

### AC-3

**Given** a git repository **When** `devops init` runs **Then** it writes a hook that
redacts secrets and calls `devops verify`; with a hook another tool wrote, it leaves
that hook unchanged; with `--dry-run` it writes no hook. Run with a PATH that lacks
`gitleaks`, the hook exits 1 naming `DEVOPS_SKIP_SECRET_SCAN=1`, and exits 0 saying
"skipped" when that is set; with claim files and no `devops`, it exits 1 naming
`DEVOPS_SKIP_CLAIM_CHECK=1`; a present tool runs and its failure stops the commit.

**Verified by:** `tests/npm-package.test.mjs` (`#ac-3`).

### AC-4

**Given** `package.json` **When** it is read **Then** both commands exist, start with a
shebang and are in `files`, and `files` lists the product but none of REQ-4's
excluded paths.

**Verified by:** `tests/npm-package.test.mjs` (`#ac-4`) and the tarball listing in
`scripts/package-smoke.sh`.

### AC-5

**Given** `package.json` **When** it is read **Then** `publishConfig` is public with
provenance, and the license, homepage, issue tracker and repository are set.

**Verified by:** `tests/npm-package.test.mjs` (`#ac-5`).

### AC-6

**Given** a pull request **When** CI runs **Then** the `package-smoke` job packs,
installs and runs the package as REQ-6 describes, and fails on a stale skill signature.

**Verified by:** `.github/workflows/ci.yml` job `package-smoke`, which runs
`scripts/package-smoke.sh`.

### AC-7

**Given** a pushed tag **When** the release workflow runs **Then** it publishes only
after the REQ-7 checks pass and the `npm-release` environment is approved.

**Verified by:** `.github/workflows/release-npm.yml`, which is reviewed. A release
dry run is described in `docs/RELEASING.md`.

### AC-8

**Given** a linked worktree, a repository with `core.hooksPath`, a folder outside git,
or copied Claude Code hooks some of which `settings.json` references **When**
`devops init` runs **Then**:
- the worktree's hook lands where Git runs it, and the summary says so;
- `core.hooksPath` gets nothing written and a hand-wiring note;
- outside git, the summary says "not a git repository";
- the summary names exactly the unreferenced hooks;
- without `gitleaks` and `devops` on PATH, the "secret scan" and "claim check" lines
  say each cannot run and name its skip variable; with both, each says it runs.

**Verified by:** `tests/npm-package.test.mjs` (`#ac-8`), with a stub `git`
(`tests/fixtures/stub-git.mjs`); tests never run the real git.

### AC-9

**Given** an empty folder **When** `devops-analyze --help`, `-h`, `--version`, `-v` or an
unknown flag such as `--bogus` (also `--help --bogus`) runs **Then** the first two print usage and exit 0, the
third prints the package version and exits 0, and the last exits non-zero with a
one-line message naming `--bogus` and `--help`; the folder stays empty.

**Verified by:** `tests/npm-package.test.mjs` (`#ac-9`).

### AC-10

**Given** a local package install (including a nonstandard path or `DEVOPS_ROOT`)
**When** init runs **Then** every constitution read path in generated `AGENTS.md`
exists relative to the target project, uses forward slashes, and appears in the
printed first steps; no constitution is copied. With an external package root,
both instructions name the package and package-relative files without absolute
constitution paths. Both `--target` forms resolve against the target, not cwd.

**Verified by:** `tests/init-agent-bootstrap.test.mjs` (`#ac-10`).

### AC-11

**Given** a project without `specs/` **When** init runs **Then** the printed steps
say to create `specs/` and write the first spec there, with no auto-loaded claim.

**Verified by:** `tests/init-agent-bootstrap.test.mjs` (`#ac-11`).

### AC-12

**Given** no `.gitignore`, or one with LF/CRLF content, with or without a final
newline or with some of the entries already present **When** init runs twice
**Then** exactly one line each of `AGENTS.override.md`,
`.workflow/state/install-manifest.json` and `.workflow/state/originals/` exists,
in that order after the existing content, and existing bytes and line endings
remain unchanged. This also applies outside git. A dry run with a missing file or entry
reports the proposed additions and leaves every project file and directory unchanged.

**Given** a project where only analyze has run **When** analyze runs twice
**Then** the two manifest lines are added once, a `.gitignore` that already has
them is left byte for byte, a project without one gets a new one, and uninstall
restores the original file or removes the one DevOPs created.

**Verified by:** `tests/init-agent-bootstrap.test.mjs` and
`tests/install-manifest.test.mjs` (`#ac-12`).

### AC-13

**Given** a project **When** init runs with the package inside it **Then** the installed
`CLAUDE.md` names `AGENTS.md`, the live constitution files and `.workflow/state/budget.yml`,
each backticked repository path it names exists from the project, and it contains none of
`runtime/`, `blueprint.md`, `LAUNCH_READINESS` or `Stratum`. With the package outside the
project the constitution references are package-relative with no absolute path.

**Verified by:** `tests/init-agent-bootstrap.test.mjs` (`#ac-13`).

### AC-14

**Given** an existing `CLAUDE.md` **When** init runs **Then** it is unchanged. **Given**
`--dry-run` **Then** nothing is written and `would install: CLAUDE.md` is reported. The
package file list does not include the repository's `CLAUDE.md`.

**Verified by:** `tests/init-agent-bootstrap.test.mjs` (`#ac-14`), `tests/npm-package.test.mjs`.

### AC-15

**Given** the repository **When** the support-policy test runs **Then** `docs/RELEASING.md`
has the section with the 90-day and minor-only Node floor rules, its stated Node floor
equals `engines.node`, and `SECURITY.md` links to it.

**Verified by:** `tests/support-policy.test.mjs`.

### AC-16

**Given** the README's Quick start section **When** the tests run **Then** every `npx`, `npm`,
`node` and `devops` command in its fenced blocks names this package, a `package.json` bin or
script, an existing script file, or a subcommand and flag that `devops help` lists, and a
command that does not is reported. The check makes no network call and installs nothing.

**Verified by:** `tests/docs/readme-quickstart.test.mjs`.

### AC-17

**Given** a package that packs the same way twice **When** `scripts/pack-twice.mjs` runs
**Then** it exits 0. **Given** a package that embeds a timestamp **Then** it exits 1 and
names the differing entry. Both workflows call it.

**Verified by:** `tests/scripts/pack-twice.test.mjs`.

### AC-18

**Given** a code, template or config file in the repository that carries a `schema_version`
field **When** the tests run **Then** `docs/STATE.md` names that file, has a "Restore drill"
section, and names only source files that exist. A file that is not named is reported by path.

**Verified by:** `tests/docs/state-doc.test.mjs`.

### AC-19

**Given** a project with the package installed under `node_modules/@miltonadina/devops`,
and one using a package outside the project **When** `devops init` runs **Then** every
backticked path in its "Next steps" and "First steps in the agent" exists from the project
or from the package root, except `.workflow/client/profile.yml`, which the steps tell the
user to create; and no step tells the user to run a command such as `/checkpoint`.

**Verified by:** `tests/init-agent-bootstrap.test.mjs`.

### AC-20

**Given** a project with a `.gitignore` **When** `devops analyze` and `devops init` run, and
run again after local edits **Then** every file they wrote is in the manifest with its
current sha256, the `.gitignore` entry keeps the first run's `original` and its copy holds
the original bytes, a dry run records nothing, and a committed manifest with a `..` or
absolute path, a path DevOPs does not write, a foreign `original` copy, another schema or
an extra key makes analyze and init exit 1 without writing. A manifest started where an
earlier DevOPs left `install.log` is `adopted`, and a creation whose write failed after the
file appeared stays recorded.

**Verified by:** `tests/install-manifest.test.mjs`.

### AC-21

**Given** a project with its own `CLAUDE.md` and `.gitignore` **When** `devops analyze`,
`devops init` and `devops uninstall` run **Then** every file and folder below the project
is as it was before, byte for byte (Git's own folder aside), and the pre-commit hook is
gone. A dry run reports the plan and changes nothing. An edited file, a hook that is no
longer DevOPs's, a recorded file replaced by a symlink, a changed original copy, and in an
`adopted` install a file with a recorded original are each left unchanged and named, and
the edited ones stay in the manifest. A manifest Git tracks makes uninstall exit 1 without
changes. An uninstall stopped part-way by a file it cannot remove leaves the project as it
was before once run again. A `core.hooksPath` set after init does not stop the DevOPs hook
being removed or cause another hook to be touched. Without a manifest uninstall changes
nothing, and an unknown option exits 1.

**Verified by:** `tests/uninstall.test.mjs`.

### AC-22

**Given** the package installed inside the project, or outside it, **When** `devops init`
installs `AGENTS.md` **Then** every backticked path in it exists in the project, or names
a file the package ships, or is project state under `.workflow/`, or is one of the named
exceptions (a branch pattern, the project's `specs/`, `AGENTS.override.md`, the project's
`package.json`); at least 15 package files are named from the project; it holds no
absolute machine path; and a slash command is named only with the plugin it needs.

**Verified by:** `tests/init-agent-bootstrap.test.mjs`.

## Out of scope

- Publishing `runtime/` (`@miltonadina/devops-runtime` stays `private`).
- Making the graph pipeline (`/sprint` and `scripts/graph-*`) work outside this
  repository.
- Compiling the TypeScript tools to JavaScript.
