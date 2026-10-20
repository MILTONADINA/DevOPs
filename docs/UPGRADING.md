# Upgrading DevOPs

## Upgrading from 0.4.0 to 0.5.0

Match the scope you installed with. The commands below use `npx` so they work for a global, a project or a one-shot install; with a global install you can drop the `npx @miltonadina/devops` prefix and type `devops`.

```sh
# global install
npm install -g @miltonadina/devops@latest

# project install (run in the project)
npm install @miltonadina/devops@latest
```

Then check the version and refresh the project's installed files. `init` needs `.workflow/profile.yml`, so run `analyze` first if the file is absent. `init` never overwrites an existing `AGENTS.md`, `CLAUDE.md` or `.mcp.json` entry.

```sh
npx @miltonadina/devops version
npx @miltonadina/devops analyze
npx @miltonadina/devops init --dry-run     # shows what init would change, writes nothing
npx @miltonadina/devops init
```

To roll back, install `@miltonadina/devops@0.4.0` in the same scope and restore the project files `init` copied (hooks, skills, subagents) from version control. Do not stay on 0.4.0: it is affected by GHSA-c3g3-xw48-qrp3 below.

### Security: upgrade promptly (GHSA-c3g3-xw48-qrp3)

**Severity: High (published advisory). Upgrade promptly.** A command classifier bypass allowed a non-breaking space (U+00A0) or other Unicode whitespace before `#`, causing the hook to treat the rest of a command line as a comment while the shell would have executed it.

The fix changes the word separator to space, tab, and newline only — matching the shell exactly — and refuses any other Unicode whitespace or format character outside quotes.

**Action:** upgrade as soon as possible. No configuration change required.

### `npm run setup` now uses `--ignore-scripts`

`npm run setup` installs runtime dependencies with `npm ci --ignore-scripts`. Dependency install scripts no longer run on first setup. This applies to the `runtime/` dependencies of a DevOPs checkout. An explicit allowlist (empty today, `scripts/setup-local.mjs`) rebuilds named packages with `npm rebuild --prefix runtime <package>`.

**Action:** if you work in a DevOPs checkout and a runtime dependency fails without its install script, rebuild only that package with the command above. Do not run an unrestricted `npm rebuild`.

### `AGENTS.md` paths point to installed location

`devops init` now points `AGENTS.md` and the first steps it prints at the constitution files where the package is installed, instead of `constitution/` files a project does not have. The package stays a live dependency; nothing is copied.

**Action:** an existing `AGENTS.md` is never rewritten, so one copied by 0.4.0 keeps its project-relative `constitution/PRINCIPLES.md`, `constitution/ANTIPATTERNS.md` and `constitution/LOOP.md` references. Edit them to point at the installed package (the paths a fresh `devops init` prints), or delete `AGENTS.md` and rerun `init`.

### `AGENTS.override.md` added to `.gitignore`

`devops init` adds `AGENTS.override.md` to `.gitignore` once, keeping existing content and line endings.

**Action:** none. `AGENTS.override.md` is a per-machine file that stays out of git; keep it untracked. If it was already committed, run `git rm --cached AGENTS.override.md`.

### The shipped `CLAUDE.md` changed

`devops init` now installs a short consumer `CLAUDE.md` (from `templates/claude-md/CLAUDE_TEMPLATE.md`) instead of this repository's own development `CLAUDE.md`, which named files a project does not have. The package no longer ships the repository's `CLAUDE.md`. An existing `CLAUDE.md` is never replaced.

**Action:** if you are upgrading an existing project, `devops init` will not overwrite your `CLAUDE.md`. Review it manually if you want the new template content.

### `devops-analyze --help` no longer writes files

`devops-analyze --help` and `-h` now print usage and exit without writing any file. An unknown flag exits with code 2 before any scan.

**Action:** no migration needed. Only affects error reporting.

### `devops init --dry-run` output corrected

`devops init --dry-run` now ends by saying it wrote nothing, instead of saying the project was initialized.

**Action:** no migration needed.

### `devops analyze` language detection

`devops analyze` now detects languages from file extensions when no manifest names one. It walks at most depth 4 with 2,000 entries, reads one entry at a time, and skips symbolic links, hidden folders, and `node_modules`. A manifest still wins.

**Action:** no migration needed.

### `devops init` safety gates improved

`devops init` no longer leaves safety gates silently off. It writes the pre-commit hook where Git runs hooks (`git rev-parse --git-path hooks`), so worktrees and submodules get one. It writes nothing into a `core.hooksPath` folder.

**Action:** review the "Safety gates" summary printed at the end of `devops init`.

### Security policy

A new `SECURITY.md` documents supported versions (latest 0.x minor), supported Node range, private reporting through GitHub private vulnerability reporting, scope, and how to verify release provenance with `npm audit signatures`.

**Action:** review `SECURITY.md` and file any vulnerability reports privately.

### Commit history rewritten (2026-10-11)

On 2026-10-11 the commit history was rewritten to remove Claude attribution lines (Co-Authored-By, Claude-Session, "Generated with Claude Code") from 93 commit messages. No file content changed, but every commit from the first such commit onward has a new SHA.

- The old history stays reachable at the tag `archive/pre-attribution-rewrite`.
- `governance/changelog/2026-10-11-attribution-rewrite-commit-map.txt` maps each old commit ID to its new one.
- Tags `v0.3.0` and `v0.4.0` moved to the new commits; `v0.2.0` stays on the old history.
- Claim `claim-2026-10-03-019` now names commit `0737952` (formerly `daa1250`).

**Action:** if you forked or branched from the original history, rebase onto the rewritten history. Use the commit map to reconcile.

## Unreleased (dev)

These items are on the `dev` branch but not yet released.

### CSP nonce replaces `unsafe-inline` for dashboard scripts

The dashboard pages (`/dashboard`, `/dashboard/graph`) now allow their inline scripts via a per-response CSP nonce instead of `script-src 'unsafe-inline'`. The HTML is sent with `Cache-Control: no-store`.

**Action:** no migration needed. The nonce is generated server-side. Ensure your proxy or firewall does not strip the CSP header.

### Agile Graph engine linking updated

`devops init` now links `@agile-graph/engine` 0.1.2 and 0.2.0 in addition to 0.1.0 and 0.1.1. Their cloud-default tool definitions match the shipped pins exactly.

`ENGINE_VERSIONS` is an allowlist: `init` links one engine that is already installed, if its version is one of the four. It installs nothing.

**Action:** none for existing links. To add the link, install a listed engine (for example `npm install -g @agile-graph/engine@0.2.0`) on Node 24 to 26, run `npx @miltonadina/devops init`, then follow the engine's own init and index steps (see the README's Agile Graph section). Pass `--no-agile-graph` to `init` to skip it.

### Subagent additions

- The reviewer subagent adds regression-across-specs, privacy-parity checks, per-branch spec and test checks, a trace-primitive-neutral observability check, unconsumed paid calls under cost, evidence for a Blocker, and a per-check "Not applicable" verdict.
- The security subagent adds an offline mode, a language-model checklist, flag injection detection, and host-project evidence.

**Action:** no migration needed. Update your subagent definitions if you have custom overrides.

## Pre-upgrade checklist

- [ ] Review this guide for breaking changes that affect your setup.
- [ ] Back up your project if you use custom `CLAUDE.md` or `AGENTS.md` edits.
- [ ] Ensure you are on Node 22.12.0 or newer (`engines.node`). The Agile Graph link needs Node 24 to 26.
- [ ] Run `npm audit` after upgrading to check for introduced vulnerabilities.
- [ ] If you use the Agile Graph link, verify engine versions after `devops init`.
- [ ] Review `SECURITY.md` for the vulnerability reporting process.
