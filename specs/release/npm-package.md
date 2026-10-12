# npm package release

**Status**: approved (owner, 2026-10-11, in chat: "get this repo ready to deploy an npm package"; first release 0.4.0, published from CI on a version tag, tsx shipped as a dependency, internal records trimmed and only what is ready shipped)
**Spec ID**: release/npm-package
**Owner**: Milton Adina

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

WHEN `devops init` runs in a git repository, IT SHALL write `.git/hooks/pre-commit`
only if no hook exists there or the existing one carries the DevOPs marker line, and
otherwise SHALL leave the existing hook unchanged and say so. The hook SHALL scan the
staged change with `gitleaks git --pre-commit --staged --redact` and SHALL validate
local claims with the `devops` command, not with a path under `~/DevOPs`. WHEN
`--dry-run` is given, `devops init` SHALL write nothing.

### REQ-4 — Package contents

The package SHALL contain the contract (`AGENTS.md`, `CLAUDE.md`), the constitution,
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
that hook unchanged; with `--dry-run` it writes no hook.

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

## Out of scope

- Publishing `runtime/` (`@miltonadina/devops-runtime` stays `private`).
- Making the graph pipeline (`/sprint` and `scripts/graph-*`) work outside this
  repository.
- A CLAUDE.md template for consuming projects: `devops init` copies this repository's
  own `CLAUDE.md` today.
- Compiling the TypeScript tools to JavaScript.
