# ADR-0026: One platform, named DevOps

Status: accepted (2026-09-26, owner directive). Amended the same day: the owner chose the directory name, asked for the move to be done rather than deferred, and asked for the old repository to be deleted (owner, 2026-09-26: "for thing waiting on me you can actually do them, rename to runtime, i dotn want bot branches but they should go under prs or issues i want starum deleted(its workl merged into devops)", verbatim).

## Context

On 2026-09-26 the owner wrote: "stratum mand devops should not exixt as 2 different repos, this is one platform. it should all be merged and called devops" (verbatim, typos included; approvals.jsonl `owner_decision` "one platform named DevOps").

The code was already in one repository. `stratum/` came in as a subtree (ed73c0d) from the only commit, 8945799, of `MILTONADINA/Stratum`, a private repository created on 2026-04-07 and never pushed again. That repository still existed, though, and this repository still presents two names:
- "stratum" (any case) appears 1,892 times in 235 files, and "CQ" (Context Quotient) names most settings and headers;
- the code reads 18 `CQ_*`, `STRATUM_*` and `DEVOPS_STRATUM_*` settings, an unpublished MCP config names three more, and the proxy uses two `x-cq-*` headers;
- the package is named `startum`;
- the local containers are `devops-stratum-*`.

Quality-plan decision O-14 had kept "Stratum" as the product name. This decision reverses it.

## Decision

1. **One platform, one name.** The platform is DevOps. Its parts are named by what they do: the DevOps proxy, DevOps memory, the pruner. "Stratum" and "CQ" survive only in history records and in deprecated aliases.
2. **One repository.** `MILTONADINA/Stratum` had no issues, pull requests, releases, secrets or forks, and its only commit is an ancestor of `main`. It was archived first, with a description pointing here, and the owner then asked for it to be deleted. A mirror bundle of it is kept locally by the maintainer before deletion.
3. **Names in code.**
   - Settings with a legacy product prefix (`CQ_`, `STRATUM_`, `DEVOPS_STRATUM_`), the proxy's `HOST`, and every new setting take the form `DEVOPS_<AREA>_<NAME>`. Vendor-defined, generic and script-local names keep theirs (the spec's keep-list). Headers with an `x-cq-` prefix, and new proxy headers, take `x-devops-`.
   - Each legacy name keeps working for one release, through one settings module that warns once per process.
   - `specs/ops/one-platform-naming.md` holds the full mapping and its acceptance criteria.
   - The S1 spec's new settings are born `DEVOPS_PROXY_*` (it was amended the same day).
4. **Directory and package (decided by the owner).**
   - `stratum/` becomes `runtime/`, and its package is named `@miltonadina/devops-runtime` (private). "Runtime" names what the directory is: the services that run on the user's machine (proxy, memory, pruner, local database), as distinct from the workflow files, skills and hooks at the root.
   - Rejected: moving everything into the root package. The two trees use different test runners (node:test and vitest), dependency sets and CI jobs, and merging them would risk every suite for no user-visible gain.
5. **Order.**
   - User-facing names and new settings change now.
   - The directory move runs as its own graph cycle right after the graph cycle that retires the billing four-eyes gate (the retirement the owner authorized on 2026-09-26). The live deploy gate's billing path patterns still match `stratum/src/billing/`, so a move before then would need two approvers.
   - The move lands before the cycles that edit runtime paths (QW-1, QW-9, S1, C1 to C4), so those are written against the final paths.
   - Claims written to the current proof template run in a detached worktree at their `git_sha`, so they survive the move. Older claims fall into the claim-retirement step already planned after C4.
   - The alias module and the doc sweep come in a naming cycle after C4, so C1 to C4 do not collide with it.

## Consequences

- **Deprecation warnings.** Users who set `CQ_*` or `STRATUM_*` variables keep working for one release and see a warning naming the new variable.
- **Local data.** A user's local database must survive the compose rename. Each stack keeps its current volume name, declared per stack: `devops-stratum-compose_db-data` for the default stack and `devops-stratum-isolated-<instance>_db-data` for an isolated one. Otherwise setup migrates each volume (the spec's REQ-4). Losing a volume would lose the stored history this platform exists to keep.
- **CI names.** The required `stratum-test` check and the `stratum` test-floor key are renamed in the move PR, with branch protection updated in the same step.
- **History stays.** Older records, including ADR-0001 to ADR-0025, keep saying "Stratum". They describe what was true then.
