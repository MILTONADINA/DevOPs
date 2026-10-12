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
- By default the engine opens public GitHub issues for some failures, under the user's
  own GitHub account, when the project's policy allows `api.github.com`. DevOps does not
  collect user data, so nothing it starts may do that.

## Requirements

### REQ-1 — An exact optional peer

`package.json` SHALL list `@agile-graph/engine` under `peerDependencies` at the exact
version that the shipped tool pins describe, marked optional in
`peerDependenciesMeta`. The pins and the version SHALL change together.

### REQ-2 — Pinned tool definitions

DevOps SHALL ship `mcp-configs/universal/agile-graph.tool-hashes.json`. The file pins the
definition SHA-256 of each tool that the engine's MCP server exposes to a cloud-backed
client with no optional tools: `context_get`, `graph_neighbors`, `memory_propose` and
`symbol_search`. It SHALL pin no tool that starts, plans or cancels a run. The engine
refuses to start when an exposed tool is unpinned or differs.

### REQ-3 — `devops init` registers the MCP server when it can

WHEN `devops init` runs, THE INSTALLER SHALL register the engine for the project only if
all of these hold:

- the engine resolves from the project, or else from where DevOps is installed;
- its version equals the REQ-1 version;
- the installer runs on a Node version the engine supports (24 or later, below 27);
- `--no-agile-graph` was not given.

Otherwise it SHALL print one informational line and carry on with exit status 0. To
register the server it SHALL:

- copy the REQ-2 pins to `.claude/agile-graph-tool-hashes.json` unless that file exists.
  An existing file is kept, with a note when its content differs.
- add an `agile-graph` entry under `mcpServers` in the project's `.mcp.json`, creating
  the file if needed. It keeps every other key, never replaces an existing `agile-graph`
  entry, and leaves a `.mcp.json` it cannot parse unchanged, with a message.
- print the two commands the person runs next: `agile-graph -C . init --cloud-mcp
  --export '<glob>'` and `agile-graph -C . index --lexical`.

The installer SHALL NOT run `agile-graph init` or `index` itself. `init --cloud-mcp
--export` decides which files a cloud-backed client may receive, so the person makes that
choice. Claude Code also asks each person to approve a project's `.mcp.json` server
before it starts one. With `--dry-run` the installer SHALL write nothing and report what
it would do.

### REQ-4 — The registered launch line

The `.mcp.json` entry SHALL:

- start the engine's `mcp` command with `-C .`, `--client cloud` and `--tool-hashes
  .claude/agile-graph-tool-hashes.json`, and with no `--allow-tool`, `--allow-run` or
  `--allow-run-status`;
- set `GRAPH_ENGINE_NO_FEEDBACK=1`;
- run `npx --no-install agile-graph` when the engine resolved from the project, or
  `agile-graph` when it resolved from where DevOps is installed.

The paths are relative so that a committed `.mcp.json` works on every clone; Claude Code
starts project servers in the project root. Started anywhere else, the server finds no
Agile Graph project and refuses to start.

### REQ-5 — No feedback from anything DevOps documents

Every Agile Graph command that DevOps documents or runs SHALL set
`GRAPH_ENGINE_NO_FEEDBACK=1`. This covers the README, `/sprint`, the MCP template and
CI.

### REQ-6 — `/sprint` through Agile Graph

This repository's `/sprint` SHALL describe a person-driven cycle through the engine's CLI
for a project that holds `.graph/project.json` with the REQ-1 engine on a supported Node:

- `plan` (from an objective with acceptance criteria, or from a spec);
- `run`;
- `inspect`;
- `accept` or `reject`, which a person decides.

It SHALL keep the halt check and preflight first. It SHALL state the prerequisites `run`
needs: a worker provider, a registered check whose image is already pulled, and a
running Docker-compatible engine. It SHALL keep the deploy gate for anything after
`accept`. It SHALL NOT enable run tools over MCP by default; it explains how a person
opts in after reviewing new pins. Without those conditions `/sprint` runs DevOps's own
pipeline unchanged.

### REQ-7 — An end-to-end check

CI SHALL run, on a Node version the engine supports:

- install the packed DevOps and the REQ-1 engine into an empty project;
- check that `mcp-tools --client cloud --hashes` equals the shipped pins;
- run `devops init`;
- start exactly the command and arguments `devops init` wrote, and check that
  `tools/list` returns the four pinned tools.

## Acceptance criteria

### AC-1

**Given** `package.json` **When** it is read **Then** `@agile-graph/engine` is an
optional peer at an exact version, and the shipped pin file holds exactly the four REQ-2
tools, each with a 64-character lowercase hex SHA-256.

**Verified by:** `tests/agile-graph-link.test.mjs`, test titles naming
`specs/graph/agile-graph-link.md#ac-1`.

### AC-2

**Given** a project **When** the link runs with the engine missing, at another version,
on Node 22 or 27, or with `--no-agile-graph` **Then** it writes nothing and reports one
reason, and `devops init` still succeeds.

**Verified by:** `tests/agile-graph-link.test.mjs` (`#ac-2`).

### AC-3

**Given** the REQ-1 engine in the project and a supported Node **When** the link runs
**Then** `.mcp.json` gains an `agile-graph` entry that matches REQ-4 and the pin file is
copied. With `--dry-run` it writes nothing.

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

**Given** this repository's `/sprint` **When** it is read **Then** it describes the
REQ-6 cycle, its prerequisites, the person's accept step and the unchanged fallback, and
the dashboard line still follows the Workflow block.

**Verified by:** `tests/agile-graph-link.test.mjs` (`#ac-6`) and
`tests/graph-dashboard/sprint-doc.test.mjs`.

## Out of scope

- A `/sprint` for npm users.
- Wiring Agile Graph into Codex, Cursor or other clients. The MCP template documents the
  launch line for manual use.
- Running `agile-graph init`, `index` or `embeddings-provision` for the user.
- Enabling run tools (`--allow-run`) or run status (`--allow-run-status`) for a cloud
  client.
