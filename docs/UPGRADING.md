# Upgrading DevOPs

## Unreleased (dev)

These changes are on `dev` and ship in the next release.

### The pre-commit hook stops instead of skipping a check

The hook that `devops init` writes used to skip a check without a word when its tool was missing. Now it stops the commit in two cases. Run `devops init` again to get the new hook: init replaces its own hook, keeps a copy of the old one, and lists both checks under `secret scan:` and `claim check:` in its "Safety gates" summary.

- Without `gitleaks` on PATH, install `gitleaks`. Or scan the staged changes some other way, for example with `gitleaks git --pre-commit --staged --redact` on another machine, and commit once with `DEVOPS_SKIP_SECRET_SCAN=1`. That variable turns the scan off for that commit.
- With `.workflow/proofs/*.yml` claims in the project and no `devops` command on PATH or in `node_modules/.bin`, run `npm install -D @miltonadina/devops`, or commit with `DEVOPS_SKIP_CLAIM_CHECK=1`.

### `budget-brake.sh` caps new sessions

`budget-brake.sh` now caps a session before its first ledger line, and blocks a call (exit 2) when it cannot read the ledger. A session that used to run uncapped can now stop at its budget, so check the caps in `.workflow/state/budget.yml`.

### Replaced files are backed up first

When `devops init` or `devops analyze` replaces an installed skill, hook, subagent, its own pre-commit hook or `.workflow/profile.yml` whose bytes differ from the new copy, it first saves the old file under `.workflow/state/backups/<UTC stamp>/` and names it on a `↻ Replaced` line. Re-apply local edits from there.

### Init records what it writes, and `devops uninstall` removes it

`devops analyze` and `devops init` now record every file they write in `.workflow/state/install-manifest.json`, with a copy of any file that was there before under `.workflow/state/originals/`. `devops uninstall --dry-run` shows what `devops uninstall` would remove or put back. A file you edited since is left in place and named.

Init and analyze add `.workflow/state/install-manifest.json` and `.workflow/state/originals/` to `.gitignore`, so the manifest stays out of Git. If you already committed them, run `git rm --cached -r --ignore-unmatch .workflow/state/install-manifest.json .workflow/state/originals` and commit that before uninstalling. Uninstall refuses a manifest or originals folder that Git tracks, because it did not come from an install on this machine. The `.mcp.json` entry and Agile Graph pin that linking writes are not recorded yet; remove them by hand.

A project installed by an earlier release has no manifest. If that install verified at least one skill, it left `.workflow/state/install.log`, and the first `analyze` or `init` after you upgrade starts the manifest marked `adopted`. In an adopted install:

- A file the earlier release wrote and this release rewrites is recorded with the earlier copy as its original. Uninstall names it for you to check, and does not restore it.
- A file the earlier release wrote that this release leaves alone is not recorded at all. Uninstall cannot see it, so check `.claude/` and `.workflow/` by hand.

To have everything recorded from a clean state instead, remove the old install before you run `analyze` and `init`. Copy aside what is yours first:

- your edits to `AGENTS.md` and `CLAUDE.md`;
- `.workflow/client/profile.yml`;
- `.workflow/proofs/`;
- the budgets in `.workflow/state/budget.yml`.

Then remove `.claude/skills/`, `.claude/hooks/`, `.claude/agents/`, `.workflow/`, the `AGENTS.override.md` line in `.gitignore`, and the DevOPs pre-commit hook in Git's hooks folder. Put your copies back after `init`.

### The installed `AGENTS.md` names files you can open

`devops init` now writes every package path in `AGENTS.md` as a path from the project, or as a file in the `@miltonadina/devops` package. Init never overwrites an existing `AGENTS.md`, so to get the new text, move yours aside and run `devops init` again. Then put your changes back: personal ones in `AGENTS.override.md`, which is gitignored, and rules the team shares in a tracked file such as the project's `specs/`.

### Stack-specific skills are looked up where they are

`devops init` used to drop the recommended stack-specific skills (Next.js, Stripe, FastAPI, Supabase, Rust) without a word. It now finds them under `skills/stack-specific/` and checks each one against `governance/skill-manifest.yml`. None is signed yet, so for now each is reported on a `⚠ skipped:` line and not installed.

## Upgrading from 0.4.0 to 0.5.0

Match the scope you installed with. The commands below use `npx` so they work for a global, a project or a one-shot install; with a global install you can drop the `npx @miltonadina/devops` prefix and type `devops`.

```sh
# global install
npm install -g @miltonadina/devops@latest

# project install (run in the project)
npm install @miltonadina/devops@latest
```

Then check the version and refresh the project's installed files. `init` needs `.workflow/profile.yml`, so run `analyze` first if the file is absent. `init` never overwrites an existing `AGENTS.md`, `CLAUDE.md` or `.mcp.json` entry. It does replace installed skills, hook scripts, subagents and its own pre-commit hook, and `analyze` rewrites `.workflow/profile.yml`. From the next release, a replaced file that differs from the new copy is first saved under `.workflow/state/backups/<UTC stamp>/`, and each one is named on a `↻ Replaced` line, so re-apply local edits from there.

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

## Upgrading from 0.5.0 to 0.5.1

Install `@miltonadina/devops@0.5.1` in the scope you use, then run `npx @miltonadina/devops init` in the project, as in the 0.5.0 steps above.

### CSP nonce replaces `unsafe-inline` for dashboard scripts

The dashboard pages (`/dashboard`, `/dashboard/graph`) now allow their inline scripts via a per-response CSP nonce instead of `script-src 'unsafe-inline'`. The HTML is sent with `Cache-Control: no-store`.

**Action:** no migration needed. The nonce is generated server-side. Ensure your proxy or firewall does not strip the CSP header.

### Subagent additions

- The reviewer subagent adds regression-across-specs, privacy-parity checks, per-branch spec and test checks, a trace-primitive-neutral observability check, unconsumed paid calls under cost, evidence for a Blocker, and a per-check "Not applicable" verdict.
- The security subagent adds an offline mode, a language-model checklist, flag injection detection, and host-project evidence.

**Action:** no migration needed. Update your subagent definitions if you have custom overrides.

## Upgrading from 0.5.1 to 0.5.2

### `client-boundary.sh` fails closed

`client-boundary.sh` no longer evaluates allowlist lines. It compares normalised paths by directory boundary, reads every path field of the PreToolUse JSON on stdin (with `~` expanded), and writes valid JSON event lines.

**Action:** `init` copies the hooks your profile lists into `.claude/hooks/` and replaces existing copies. If your project uses this hook, install `@miltonadina/devops@0.5.2` and run `npx @miltonadina/devops init` to replace it.

## Upgrading from 0.5.2 to 0.6.0

### Skills install only once cosign verifies them

`devops init` copies a signed skill only after `cosign` verifies that its signature comes from this repository's `release-sign.yml`. Without `cosign` on `PATH`, each skill is reported as unverified and none is installed.

**Action:** install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) before running `init`. To install without verification, pass `--allow-unsigned --rationale="<why>"`; each skill is then logged as overridden.

### Agile Graph engine linking updated

`devops init` now links `@agile-graph/engine` 0.4.0 only. The engine changed the cloud-default definitions of `context_get`, `graph_neighbors`, `memory_propose` and `symbol_search`, so the shipped pins are 0.4.0's. Those pins do not match 0.1.0 to 0.2.0, so `init` no longer links them.

`ENGINE_VERSIONS` is an allowlist: `init` links one engine that is already installed, if its version is listed. It installs nothing.

**Action:** a project linked to an older engine keeps working with that engine and its pin file. Before it upgrades the engine to 0.4.0, replace `.claude/agile-graph-tool-hashes.json` with `mcp-configs/universal/agile-graph.tool-hashes.json` from this release: the 0.4.0 server refuses to start against the old pins, and `init` keeps an existing pin file, so it will not replace it. To link a new install, install `@agile-graph/engine@0.4.0` on Node 24 to 26, run `npx @miltonadina/devops init`, then follow the engine's own init and index steps (see the README's Agile Graph section). Pass `--no-agile-graph` to `init` to skip it.

## Upgrading from 0.6.0 to 0.6.1

### Hook gates fail closed

The deploy and sealed-ref PreToolUse wrappers now block the call (exit 2) when `jq` is missing, when the payload is not valid JSON with a string command, or when the gate itself fails. Before, these cases let the call through. Hooks that are not wired by default (`block-rm-rf.sh`, `block-secrets.sh`, `block-prod-write.sh`, `budget-brake.sh`, `external-content-boundary.sh`) are hardened the same way (GHSA-869v-8545-rv5q).

**Action:** make sure `jq` is installed wherever Claude Code runs these hooks, then run `devops init` to copy the updated hooks. `block-prod-write.sh` now accepts only a JSON approval for the exact command from the last five minutes, so record approvals in that form.

## Upgrading from 0.6.1 to 0.6.2

### No writes through project symlinks

`devops init`, `devops-analyze`, `scripts/graph-blocked.sh` and `scripts/graph-preflight.mjs` refuse to write, append or change a file's mode through a symlink inside the project, and no longer follow it to a file outside the project (GHSA-rm9j-37wp-mwc3). A project that commits a symlink at `.claude`, `.claude/hooks/<hook>`, `.gitignore`, `.workflow` or `.workflow/profile.yml` now gets exit 1 naming the link.

**Action:** if `devops init` or `devops-analyze` names a symlink, replace it with a regular file or directory and run the command again.

## Pre-upgrade checklist

- [ ] Review this guide for breaking changes that affect your setup.
- [ ] Back up your project if you use custom `CLAUDE.md` or `AGENTS.md` edits.
- [ ] Ensure you are on Node 22.12.0 or newer (`engines.node`). The Agile Graph link needs Node 24 to 26.
- [ ] Run `npm audit` after upgrading to check for introduced vulnerabilities.
- [ ] If you use the Agile Graph link, verify engine versions after `devops init`.
- [ ] Review `SECURITY.md` for the vulnerability reporting process.
