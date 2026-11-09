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

WHEN `devops init` finishes, or runs as a dry run, THE SYSTEM SHALL print the same "Next steps" and "First steps in the agent" text, and every file it names there SHALL be a GitHub URL of the form `https://github.com/MILTONADINA/DevOPs/blob/v<version>/<path>`, where `<version>` is the installed package's version and `<path>` exists in the repository at that release (#352, #420). THE SYSTEM SHALL NOT tell the user to run a slash command that init did not install; a command is named only with the plugin that provides it. The "Next steps" SHALL say which files to commit (AGENTS.md, CLAUDE.md, `.claude/`, `.workflow/profile.yml`, `.workflow/state/budget.yml`) and which stay local, naming the `.gitignore` entries init adds (`.workflow/state/install-manifest.json`, `.workflow/state/originals/`).

### REQ-15 — Init and analyze record what they write

WHEN `devops analyze` or `devops init` (not a dry run) writes a file in the project, or
the DevOPs pre-commit hook, THE SYSTEM SHALL record it in
`.workflow/state/install-manifest.json` (`schema_version: 1`) with the sha256 of what it
wrote, and the folders it created. WHEN DevOPs is about to write a file whose entry is
recorded and whose bytes no longer have the entry's `written` sha256, THE SYSTEM SHALL set
`edited: true` on that entry and SHALL never clear it, because the edit was made between two
DevOPs writes; `edited` is the only optional entry key, and any other value is refused. WHEN it first writes a file that already existed, THE
SYSTEM SHALL copy the existing bytes to `.workflow/state/originals/<path>` and record their
sha256 as the file's `original`, and SHALL NOT change that `original` on a later run. IF
the manifest has another `schema_version`, another key set, or a path that is not one
DevOPs writes (`AGENTS.md`, `CLAUDE.md`, `.gitignore`, the hook, or a path under
`.claude/skills/`, `.claude/hooks/`, `.claude/agents/` or `.workflow/`), or an `original`
copy that is not its own `originals/<path>`, THEN THE SYSTEM SHALL refuse to run and change
nothing. WHEN it starts the manifest in a project that already has
`.workflow/state/install.log` (an earlier DevOPs installed there), THE SYSTEM SHALL set
`adopted: true` and say so once, because an `original` recorded there may be that earlier
DevOPs's copy. IF an original copy's path leaves the project through a symlink, THEN THE
SYSTEM SHALL refuse that copy with an error and record no `original` for the file, because a
read through the link would hash a file outside the project. WHEN DevOPs records a write, before or after it, or a folder it creates, THE SYSTEM SHALL save the manifest before its next step, replacing the file whole (written to a temp file under `originals/`, flushed, then renamed) so an interrupted run keeps its records and never leaves a truncated manifest; an unconfirmed write stays pending, and uninstall keeps its file. Original copies are written whole the same way, so a copy cut short is never restored, and uninstall removes the temp files an interrupted write left. Backups (REQ-F11) and the `originals/` copies are DevOPs's own records and
are not themselves recorded. WHEN `devops init` (not a dry run) links Agile Graph
(`specs/graph/agile-graph-link.md` REQ-3), THE SYSTEM SHALL record the pin file it copies as a
file, and SHALL record each `.mcp.json` server entry it adds under `mcp_servers`, keyed by server
name, with the sha256 of that entry's JSON and `created_file`, which is true when `.mcp.json` did
not exist before that run. It SHALL NOT record `.mcp.json` as a file, because other tools share
it, and a pin file that already existed is not recorded. `mcp_servers` is an optional key: a
name must be a non-empty string of at most 128 characters, and an entry must have exactly
`sha256` (64 lowercase hex characters) and `created_file` (a boolean), or the manifest is refused.
WHEN `devops uninstall` runs, THE SYSTEM SHALL remove only the recorded server entry whose JSON
still has the recorded sha256, SHALL keep every other key and server of `.mcp.json` with the same
content, SHALL delete `.mcp.json` only when `created_file` is true and nothing else is left in it,
and SHALL keep and name an entry edited since DevOPs wrote it, leaving its record in the manifest.

WHEN `devops init` (not a dry run) copies the Claude Code hooks from `hooks/universal/` and the hook has a row in the wiring table in `analyzer/install.ts` that names an event, a command and, for a tool event, a matcher, THE SYSTEM SHALL add an entry to `.claude/settings.json` in the Claude Code hooks format, `{"hooks": {"<event>": [{"matcher": "<matcher>", "hooks": [{"type": "command", "command": "<command>"}]}]}}` (the `matcher` key is omitted for an event that has none), keeping every other key and every other hook of the file. The command of a pre or post hook is `node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/run-hook.mjs" <pre|post> <hook-file> <stdin|command|file>`, which runs the hook with the input it takes from the tool call on stdin; init copies that runner from `hooks/claude-code/` beside the hooks, and IF the runner is missing from the package while a wired hook needs it, THEN init SHALL stop with exit 1. The command of a session hook is `cd "${CLAUDE_PROJECT_DIR:-.}" && bash .claude/hooks/<file> || true`. IF `.claude/settings.json` does not exist, THEN THE SYSTEM SHALL create it with only the entries init adds. THE SYSTEM SHALL NOT add an entry for a hook that is already wired, meaning its command is in a group with the same matcher (a missing matcher compared as missing) under the same event; it SHALL print `already wired: <hook> (<event>)` for each such hook, and SHALL NOT record such an entry. The same command under another event or matcher is not already wired, and is added. IF `.claude/settings.json` is a symlink, is not a regular file, or is not a JSON object, THEN THE SYSTEM SHALL leave it unchanged, say so in its output, and record no entry. A hook without a wired row, because it is opt-in or is not mapped to a Claude Code event, SHALL be named with its reason and not wired.

WHEN init adds an entry, THE SYSTEM SHALL record it under `claude_hooks` in the manifest, as `{ event, matcher, command, sha256 }` (`matcher` omitted for an event that has none), where `sha256` is the sha256 of the JSON of the inner hook object, and SHALL record `claude_hooks_created_file`, which is true when `.claude/settings.json` did not exist before the first run that added an entry. `claude_hooks` is an optional key: each entry must have exactly `event`, `command` and `sha256`, plus `matcher` when it has one; an `event` of letters; a `command` of one of the forms init writes (the runner form, or the plain `cd` form for a session hook); and a `sha256` of 64 lowercase hex characters, or the manifest is refused.

WHEN `devops uninstall` runs, THE SYSTEM SHALL remove only the recorded entry whose inner hook object still hashes to the recorded sha256, SHALL drop a matcher group, an event or `hooks` that is left empty, SHALL delete `.claude/settings.json` only when `claude_hooks_created_file` is true and nothing is left in it, SHALL keep and name an entry edited since DevOPs wrote it, leaving its record, and SHALL write the file whole and keep its permissions. WHEN run with `--dry-run`, init SHALL say which entries it would add and change nothing.

### REQ-16 — Uninstall removes what was recorded

WHEN `devops uninstall` runs in a project with an install manifest (REQ-15), THE SYSTEM
SHALL remove each recorded file DevOPs created whose bytes still have the recorded
`written` sha256, SHALL put back each recorded original whose file still holds what DevOPs
wrote (or is gone) and whose copy still has the recorded `original` sha256, SHALL remove
the pre-commit hook only while it carries the DevOPs marker and its recorded bytes, and
SHALL remove the folders DevOPs created that are then empty. WHEN a recorded entry is marked `edited`
(REQ-15), THE SYSTEM SHALL keep its file and name it as edited since DevOPs wrote it, and
SHALL neither restore an original over it nor remove it, before any other decision. IF a recorded file was edited,
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
URL in its "Next steps" and "First steps in the agent" is a `https://github.com/MILTONADINA/DevOPs/blob/v<version>/<path>` URL whose `<path>` exists in the repository and ships in the package, and every other backticked path exists from the project, except `.workflow/client/profile.yml`, which the steps tell the
user to create; and no step tells the user to run a command such as `/checkpoint`.

**Verified by:** `tests/init-agent-bootstrap.test.mjs`, `tests/init-closing-urls.test.mjs`.

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

### AC-23

**Given** a project with a `.gitignore` **When** `devops analyze` runs, the user then adds a
`dist/` rule to `.gitignore`, `devops init` runs, and `devops uninstall` runs **Then**
uninstall keeps `.gitignore` and names it as edited since DevOPs wrote it, the `dist/` rule
is still in the file, and the entry stays in the manifest with `edited: true`. A file not
edited between two DevOPs runs is still restored to its original bytes.

**Verified by:** `tests/uninstall.test.mjs`.

### AC-24

**Given** a project whose `.workflow/state/originals` is a symlink to a folder outside it,
holding a `.gitignore` **When** `devops analyze` runs **Then** it exits non-zero naming the
symlink, appends nothing to `.gitignore`, and the manifest records no `original` for
`.gitignore` (the outside file's hash is not recorded). **And** when `devops uninstall` runs
in a project whose recorded original copy is reached through such a symlink, it keeps that
file, names the symlink, and exits 0.

**Verified by:** `tests/install-manifest.test.mjs` and `tests/uninstall.test.mjs`.

### AC-25

**Given** a project with a `.gitignore` **When** `devops init` runs and a SIGTERM stops it
while signature verification (cosign) is blocked, after `AGENTS.md` and `.gitignore` were
written **Then** the manifest on disk records both files with their sha256, and a later
`devops uninstall` removes `AGENTS.md`. **And** a write that is recorded but not yet made is
already in the manifest on disk, no temporary manifest is left behind, and uninstall removes
the temp files an interrupted write left under `originals/`.

**Verified by:** `tests/install-manifest.test.mjs`.

### AC-26

**Given** a project with a `.mcp.json` that holds another server and an extra top-level key, or
no `.mcp.json` at all **When** `devops init` links Agile Graph and `devops uninstall` runs
**Then** the pin file and the `agile-graph` server are gone, the other server and the extra key
keep their content, and `.mcp.json` is gone when init created it. **And** an `agile-graph` entry
edited after init is kept and named, its record stays in the manifest, and a manifest whose
`mcp_servers` is malformed makes uninstall exit 1 with nothing changed. A dry run changes
nothing.

**Verified by:** `tests/uninstall.test.mjs`.

### AC-27

**Given** an empty project **When** `devops init` runs **Then** `.claude/settings.json` names the SessionStart command for `load-baton.sh` and the PreToolUse Bash commands for `deploy-gate.sh`, `block-sealed-refs.sh`, `block-prod-write.sh`, `block-rm-rf.sh` and `block-new-dependency.sh` (each run through `.claude/hooks/run-hook.mjs`), copies `run-hook.mjs`, and init names each copied hook it does not wire with its reason. **And** the Bash command init wrote for `block-rm-rf.sh`, given a `rm -rf /` PreToolUse payload on stdin, exits 2, and every wired Bash command, given an `ls` payload, exits 0. **And** given a settings.json with other keys and a user's own hook, init keeps them all, a second init adds no duplicate, and a hook already wired under the same event and matcher is named as already wired and neither changed nor recorded. **And** a symlinked or non-object settings.json is left unchanged with a warning, and a dry run changes nothing. **And** `devops uninstall` removes only the recorded entries, deletes the file when init created it, keeps and names an entry edited since, takes only the entry in the group init wrote to (a user's identical command in another group stays), keeps every file under `.claude/hooks/` that a command still in the file runs, recorded or not, and every module such a hook calls beside it (such as `protect-gates.mjs` or `graph-command-classifier.mjs`), until that command is gone, rewrites the file before it deletes any hook file, and keeps every hook file the entries run when the file cannot be rewritten, and exits 1 with nothing changed when `claude_hooks` is malformed. **And** init and uninstall rewrite settings.json through a temp file that they create exclusively under a unique name, so a pre-existing `.claude/settings.json.tmp` is never read, overwritten or removed, and on a failed write only the temp file they made is removed; the rewrite keeps the file's indentation (a tab, or the spaces of its first indented line, 2 when there is none) its trailing newline if it had one, and CRLF line ends; a settings.json with a number literal outside a string that JSON.parse would not keep exactly (an integer above 2^53, a decimal with more digits than a double holds, or a value that becomes Infinity) is left unchanged with a warning, and init records no entry for it; and uninstall deletes an event array, or `hooks`, only when init created it and uninstall's own removal emptied it, leaving every other empty array as it was, except that for a manifest without `claude_hooks_created_events` (written by 0.8.x) it deletes every event array and `hooks` its removal empties, as 0.8.x did (#426).

**Verified by:** `tests/install-claude-hooks.test.mjs`, `tests/hooks/run-hook.test.mjs`.

### AC-28

WHEN an agent's Write, Edit, MultiEdit or NotebookEdit call targets a DevOPs gate or approval path (`.claude/settings.json`, `.claude/settings.local.json`, anything under `.claude/hooks/`, `.workflow/state/approvals.jsonl`, `.workflow/state/install-manifest.json`, or anything under `.workflow/state/originals/`), judged by file identity, THE SYSTEM SHALL block the call with exit 2, so that the agent cannot change its own gates or approvals. WHEN an agent's Bash command names one of those paths, or moves a bare `.claude`, `.workflow` or `.workflow/state`, and is not a plain read, THE SYSTEM SHALL block it with exit 2. The Bash check is a convenience guard, not a security boundary.

**Given** a project that `devops init` wrote **When** `protect-gates.sh` runs on a file-tool target that is one of those paths, or on an absolute path that reaches one through a symlink, a hard link, a `..` component, or a link inside a gate directory that points out of it (including a new file under a linked directory, the missing target of a dangling link, and a hard link to a linked file; a link or hard link nested inside a linked tree is not followed), or on a letter-case or Unicode spelling of the name (folded on every platform) **Then** it exits 2 with `DevOPs GATE BLOCK`, and an empty path or any other absolute path exits 0. **And** a relative path, or one that starts with `~`, exits 2 with `is not an absolute path`. **And** a walk of a gate directory nested past 8 levels, or holding more than 5000 entries, exits 2 with `failing closed`. **And** a file or directory under a gate directory that does not exist yet is blocked too, while `src/settings.json` is allowed. **And** `protect-gates-bash.sh` exits 2 for a Bash command that names one of those paths, or moves a bare `.claude`, `.workflow` or `.workflow/state`, unless it is a plain read (`cat`, `head`, `tail`, `grep`, `ls`, `stat`, `wc`, `diff`, `jq`, `less` without `-o`, `-O`, `--log-file`, `+cmd` or `-k`, or `git add`, `git commit` or `git status`, with no chain). It exits 0 for `echo '{}' > .vscode/settings.json`, `git add .claude/settings.json`, `git commit -m "docs: explain .claude/settings.json"`, `jq '.hooks | keys' .claude/settings.json` and `cat .claude/settings.json 2>&1 | head`. **And** an internal error of either check exits 2. **And** `docs/HOOKS.md` states that the Bash check is a convenience guard and not a security boundary, and lists what it does not catch: a `cd` followed by a relative write, a path built at run time, an interpreter, and a path spelled with an extra `/` or a `.` component.

**Verified by:** `tests/hooks/protect-gates.test.mjs`, `tests/install-claude-hooks.test.mjs`.

### AC-29

IF the install manifest's `claude_hooks` names a hook file whose name starts with a dot, pairs a run-hook `pre` command with an event other than `PreToolUse`, a run-hook `post` command with an event other than `PostToolUse`, or the plain `cd … && bash` command with an event other than `SessionStart` or with a matcher, or lists the same command twice, or the manifest has `claude_hooks_created_file` without a non-empty `claude_hooks`, THEN THE SYSTEM SHALL refuse the manifest as it refuses any other malformed manifest (REQ-15) and change nothing. THE SYSTEM SHALL NOT check hook names against a list, so a manifest written by another DevOPs version that names a hook this version does not wire still reads.

**Given** a manifest with each of those defects **When** `devops analyze`, `devops init` or `readManifest` reads it **Then** it is refused with the malformed-manifest error. **And** a manifest with the plain, pre and post forms under their own events, plus a pre command for a hook this version does not wire, reads unchanged.

**Verified by:** `tests/install-manifest.test.mjs`.

### AC-30

WHEN an agent's Grep or Glob call names a sensitive path, judged as `block-secrets.sh` judges a file path (a Glob call's `pattern`, and a Grep call's `glob`), THE SYSTEM SHALL block the call with exit 2. A Grep call's `pattern` is a regex, not a path, and SHALL NOT be judged. WHEN an agent's Bash command names a word that `block-secrets.sh` refuses, once the command is split into words as a shell splits it (quotes respected and stripped; a backslash escapes the next character and a backslash-newline is removed; unquoted whitespace and `; | & < > ( )` and backticks separate words; a word that still contains whitespace is skipped as a quoted message unless it holds `$(` or a backtick, when each piece of it is checked with its quotes and backslashes removed; a command with a quote left open is also checked with every quote and backslash removed), THE SYSTEM SHALL block the command with exit 2. IF `awk` is not on PATH or fails, THE SYSTEM SHALL block the command. The Bash check is a convenience guard, not a security boundary: it reads the command text only, so it does not catch a path built by shell expansion (`$(...)`, a variable, a glob such as `.en?`) or a secret that a script, an interpreter or a program opens itself.

**Given** a project that `devops init` wrote **When** `run-hook.mjs` runs `block-secrets.sh` on a Glob call whose `pattern` is `**/.env`, or on a Grep call whose `glob` is `*.pem`, **Then** it exits 2, and on a Glob call whose `pattern` is `src/**/*.ts`, or a Grep call whose `pattern` is `id_rsa` with no `glob` or `path`, it exits 0. **And** `block-secrets-bash.sh`, given `cat .env`, `cat ./config/.ENV`, `less ~/.ssh/id_rsa`, `cp a.pem b`, `cat .env|wc`, `cat <.env`, `(cat .env)`, `cat "unclosed .env`, `cat .e''nv '`, `echo "$(cat .env)"` or ``echo `cat server.key` ``, exits 2, and given `cat .env.example`, `ls src`, `git commit -m "fix .env loading"` or `echo hi`, exits 0. **And** a profile that lists `block-secrets-bash.sh` without `block-secrets.sh` gets `block-secrets.sh` copied beside it, and init wires the Bash command for the guard. **And** `docs/HOOKS.md` states that the Bash check is a convenience guard and lists what it does not catch.

**Verified by:** `tests/hooks/block-secrets-bash.test.mjs`, `tests/hooks/run-hook.test.mjs`, `tests/install-claude-hooks.test.mjs`.

### AC-31

WHEN `run-hook.mjs` runs a `command` or `file` hook, THE SYSTEM SHALL give the hook its value on stdin and not on argv, so a value longer than one argument (128 KB on Linux) is decided like a short one, and the hook SHALL see the same `$1` and `$0` (the hook's own path) that it sees from argv. IF the value holds a NUL byte, THE SYSTEM SHALL fail closed in pre with exit 2. WHEN a hook passes a command to a helper program, THE SYSTEM SHALL pass it on stdin. A file path is passed on argv only after the hook has checked that the file exists, which bounds it by the path size limit. WHEN the deploy-gate or sealed-ref classifier is given a command longer than 4 MiB, or holding more than 4096 words or 256 commands, THE SYSTEM SHALL block it with the reason `command exceeds parser bounds`, without first analysing it. WHEN a pattern check in `block-rm-rf.sh` or `block-prod-write.sh` cannot be completed (grep exits with a status other than 0 or 1), THE SYSTEM SHALL block. IF the pre runs of one tool call have not finished within 30 seconds together, THE SYSTEM SHALL stop them and fail closed with exit 2, so no hook outlasts Claude Code's hook timeout (which lets the call through); `DEVOPS_HOOK_BUDGET_MS` may lower this budget, never raise it.

**Given** a project that `devops init` wrote **When** `run-hook.mjs` runs `block-rm-rf.sh`, `block-secrets-bash.sh`, `block-prod-write.sh`, `block-new-dependency.sh` or `protect-gates-bash.sh` on a Bash command of about 1 MB that is harmless, **Then** it exits 0. **And** `deploy-gate.sh` and `block-sealed-refs.sh` exit 2 on it within 20 seconds with `command exceeds parser bounds`, its 166,000 words being over the word bound. **And** on the same command with that hook's block trigger first, it exits 2 with the hook's normal message and without `failing closed`. **And** a command of about 1 MB ending in `rm -rf /` exits 2 with the rm-rf refusal. **And** `block-secrets.sh`, run on a `file` payload naming `/p/app/.env`, exits 2, and on `/p/src/index.ts` exits 0. **And** a command of about 1 MB holding a NUL byte exits 2 with `failing closed`, and the hook does not run. **And** the hook process's argument list does not contain the command. **And** a command that a hook logs to `.workflow/state/events.jsonl` is logged at most 4096 characters of it, marked with its length. **And** with a `grep` on PATH that exits 2, `block-rm-rf.sh` on `rm -rf /etc` and `block-prod-write.sh` on a `DROP TABLE` command exit 2. **And** on macOS, with every temp folder unwritable, `block-rm-rf.sh` still exits 2 on `rm -rf /`. **And** `rm -rf` naming 1000 in-project paths and `/etc` exits 2, while `rm -rf dist && git commit -m "<400 words>"` exits 0. **And** a pre hook that sleeps 20 seconds, run with `DEVOPS_HOOK_BUDGET_MS=1000`, exits 2 within 10 seconds with `did not finish within the 1 s hook budget`, and an invalid budget value (`abc`, `0`, `-5`, `1.5`) leaves the 30-second budget in place.

**Verified by:** `tests/hooks/long-command.test.mjs`, `tests/hooks/run-hook.test.mjs`.

## Out of scope

- Publishing `runtime/` (`@miltonadina/devops-runtime` stays `private`).
- Making the graph pipeline (`/sprint` and `scripts/graph-*`) work outside this
  repository.
- Compiling the TypeScript tools to JavaScript.
