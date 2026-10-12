# Link DevOps to Agile Graph

**Status**: approved (owner, 2026-10-11, in chat: "yes do that … open the pr"; Agile Graph's published 0.1.0 is the reference)
**Spec ID**: graph/agile-graph-link
**Owner**: Milton Adina

## Scope

Agile Graph (`@agile-graph/engine`, MIT, https://github.com/MILTONADINA/agile-graph)
grew out of this repository's graph pipeline. It indexes a project for an AI client,
holds engineering memory and runs controlled coding cycles. This spec links DevOps to it
in three places:

- `package.json` names the engine as an optional peer.
- `devops init` registers the engine's MCP server for Claude Code when the engine is
  installed.
- This repository's `/sprint` can run a cycle through the engine's CLI.

DevOps works the same without the engine. The owner approved the link without choosing
between "always hand off to Agile Graph" and "use it when installed". This spec takes
the second: every link is conditional, and DevOps's own pipeline stays the fallback.

The `/sprint` command does not ship in the npm package (`specs/release/npm-package.md`,
out of scope). For npm users the link is the MCP server; a `/sprint` for npm users is
separate, later work.

## Problem

- The engine is published, but nothing in DevOps refers to it, so a DevOps user has no
  supported way to give Claude Code the engine's project context.
- The engine's MCP server needs a pinned list of tool definitions. Without one, a
  changed or added tool, including one that starts runs, would reach the client
  unreviewed.
- The engine's automatic feedback is on by default. It opens public GitHub issues under
  the user's own GitHub account, though only for a project whose policy allows
  `api.github.com`. DevOps does not collect user data, so nothing it starts may leave
  that switch on.

## Requirements

### REQ-1 — An optional peer and one pinned version

`package.json` SHALL list `@agile-graph/engine` under `peerDependencies` with a range
that never stops `npm install` (`>=0.1.0`), marked optional in `peerDependenciesMeta`.
`ENGINE_VERSION` in `analyzer/agile-graph.js` SHALL name the one engine version whose
tools the shipped pins describe. The constant and the pins SHALL change together, and the
peer range SHALL include that version.

**Enforced by:** test:tests/agile-graph-link.test.mjs

### REQ-2 — Pinned tool definitions

DevOps SHALL ship `mcp-configs/universal/agile-graph.tool-hashes.json`. The file pins the
definition SHA-256 of each tool that the engine's MCP server exposes to a cloud-backed
client with no optional tools: `context_get`, `graph_neighbors`, `memory_propose` and
`symbol_search`. It SHALL pin no tool that starts, plans or cancels a run. The engine
refuses to start when an exposed tool is unpinned or differs.

**Enforced by:** test:tests/agile-graph-link.test.mjs; job:.github/workflows/ci.yml#agile-graph-link

### REQ-3 — `devops init` registers the MCP server when it can

WHEN `devops init` runs, THE INSTALLER SHALL look for the engine in this order:

- in the project's `node_modules` or that of any folder above it (a workspace root);
- above where DevOps is installed (a global install);
- as an `agile-graph` command on `PATH`.

It SHALL register the engine only if all of these hold:

- the engine was found;
- its version equals `ENGINE_VERSION`;
- the installer runs on a Node version the engine supports (24 or later, below 27);
- `--no-agile-graph` was not given.

Otherwise it SHALL print one informational line and carry on with exit status 0. To
register the server it SHALL:

- copy the REQ-2 pins to `.claude/agile-graph-tool-hashes.json` unless that file exists.
  An existing file is kept, with a note when its content differs.
- add an `agile-graph` entry under `mcpServers` in the project's `.mcp.json`, creating
  the file if needed. It keeps every other key and never replaces an existing
  `agile-graph` entry. It leaves a `.mcp.json` it cannot parse unchanged, with a message.
- check that both files can be written before writing either. If `.mcp.json` still
  cannot be written, it SHALL remove the pins it copied, report that nothing was linked,
  and let the install finish with exit status 0. Nothing in the link SHALL fail
  `devops init`.
- print the two commands the person runs next: `agile-graph -C . init --cloud-mcp
  --export '<glob>'` and `agile-graph -C . index --lexical`.

The installer SHALL NOT run `agile-graph init` or `index` itself. `init --cloud-mcp
--export` decides which files a cloud-backed client may receive, so the person makes that
choice. Claude Code also asks each person to approve a project's `.mcp.json` server
before it starts one. With `--dry-run` the installer SHALL write nothing and report what
it would do.

**Enforced by:** test:tests/agile-graph-link.test.mjs

### REQ-4 — The registered launch line

The `.mcp.json` entry SHALL:

- start the engine's `mcp` command with `-C .`, `--client cloud` and `--tool-hashes
  .claude/agile-graph-tool-hashes.json`, and with no `--allow-tool`, `--allow-run` or
  `--allow-run-status`;
- set `GRAPH_ENGINE_NO_FEEDBACK=1`;
- run `npx --no-install agile-graph` when the engine was found in the project or above
  it, or `agile-graph` otherwise. `npx --no-install` never downloads a package; it
  refuses when the engine is missing.

The paths are relative so that a committed `.mcp.json` works on every clone; Claude Code
starts project servers in the project root. Started anywhere else, the server finds no
pin file or project and refuses to start.

**Enforced by:** test:tests/agile-graph-link.test.mjs; job:.github/workflows/ci.yml#agile-graph-link

### REQ-5 — No feedback from anything DevOps documents

Every Agile Graph command that DevOps documents or runs SHALL set
`GRAPH_ENGINE_NO_FEEDBACK=1`. This covers the README, `/sprint`, the MCP template and its
README, the lines `devops init` prints, and CI.

**Enforced by:** test:tests/agile-graph-link.test.mjs; job:.github/workflows/ci.yml#agile-graph-link

### REQ-6 — `/sprint` through Agile Graph

This repository's `/sprint` SHALL describe a person-driven cycle through the engine's CLI
for a project that holds `.graph/project.json`, with the REQ-1 engine on a supported
Node:

- `plan` (from an objective with acceptance criteria, or from a spec);
- `run`;
- `inspect`;
- `accept` or `reject`, which a person decides.

It SHALL keep the halt check and preflight first. It SHALL state the prerequisites and
where each one fails:

- `plan` needs a permitted worker;
- `plan` warns and `run` refuses without a registered check;
- `run` refuses while a check's image is not pulled;
- runs need a running Docker-compatible engine.

It SHALL keep the deploy gate for anything after `accept`. It SHALL NOT enable run
tools over MCP by default; it explains how a person opts in after reviewing new pins.
Without those conditions `/sprint` runs DevOps's own pipeline unchanged.

**Enforced by:** test:tests/agile-graph-link.test.mjs

### REQ-7 — An end-to-end check

CI SHALL run these steps on a Node version the engine supports:

- install the packed DevOps and the `ENGINE_VERSION` engine into an empty project;
- check that `mcp-tools --client cloud --hashes` equals the shipped pins;
- run `devops init`;
- start exactly the command and arguments `devops init` wrote, and check that
  `tools/list` returns the four pinned tools;
- stop the server's whole process group, and finish within a fixed deadline.

**Enforced by:** job:.github/workflows/ci.yml#agile-graph-link

## Acceptance criteria

### AC-1

**Given** `package.json` and the link module **When** they are read **Then**:
- `@agile-graph/engine` is an optional peer whose range includes `ENGINE_VERSION`;
- the shipped pin file holds exactly the four REQ-2 tools, each with a 64-character
  lowercase hex SHA-256;
- the MCP template uses the REQ-4 arguments and environment.

**Verified by:** `tests/agile-graph-link.test.mjs`, test titles naming
`specs/graph/agile-graph-link.md#ac-1`.

### AC-2

**Given** a project **When** the link runs with the engine missing, at another version,
on Node 22 or 27, or with `--no-agile-graph` **Then** it writes nothing and reports one
reason. **When** `.mcp.json` cannot be written **Then** no pins are left behind. In every
case `devops init` still succeeds.

**Verified by:** `tests/agile-graph-link.test.mjs` (`#ac-2`).

### AC-3

**Given** the engine at `ENGINE_VERSION` and a supported Node **When** the link runs
**Then** `.mcp.json` gains an `agile-graph` entry that matches REQ-4, and the pin file is
copied. The entry starts the engine with `npx --no-install` when the engine is in the
project or a workspace root above it, and with `agile-graph` when it is next to DevOps or
on `PATH`. With `--dry-run` the link writes nothing.

**Verified by:** `tests/agile-graph-link.test.mjs` (`#ac-3`).

### AC-4

**Given** a `.mcp.json` that already names `agile-graph`, holds other servers or cannot
be parsed, or a pin file that already exists **When** the link runs **Then** the
existing entry, the other servers, the unparsable file and the existing pins are left
as they were.

**Verified by:** `tests/agile-graph-link.test.mjs` (`#ac-4`).

### AC-5

**Given** a pull request **When** CI runs **Then** the `agile-graph-link` job performs
REQ-7 with `GRAPH_ENGINE_NO_FEEDBACK=1`.

**Verified by:** `.github/workflows/ci.yml` job `agile-graph-link`, which runs
`scripts/agile-graph-smoke.sh`.

### AC-6

**Given** this repository's `/sprint`, the README, the MCP template and its README
**When** they are read **Then** `/sprint` describes the REQ-6 cycle, its prerequisites,
the person's accept step and the unchanged fallback, and every documented
`agile-graph -C` command sets `GRAPH_ENGINE_NO_FEEDBACK=1`. The dashboard line still
follows the Workflow block.

**Verified by:** `tests/agile-graph-link.test.mjs` (`#ac-6`) and
`tests/graph-dashboard/sprint-doc.test.mjs`.

## Out of scope

- A `/sprint` for npm users.
- Wiring Agile Graph into Codex, Cursor or other clients. The MCP template documents the
  launch line for manual use.
- Native Windows, which DevOps does not support (README prerequisites). There an `npx`
  entry would need `cmd /c`.
- Running `agile-graph init`, `index`, `watch` or `embeddings-provision` for the user.
- Enabling run tools (`--allow-run`) or run status (`--allow-run-status`) for a cloud
  client.
