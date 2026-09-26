# Contributing to DevOPs

DevOPs is built on a strict philosophy: every change must be justifiable,
verifiable, and surgical. This document is the rulebook.

For checkout setup and current commands, see the [developer guide](DEVELOPER_GUIDE.md).

---

## Before you write any code

1. Read `constitution/PRINCIPLES.md` — the rules every contributor and every
   agent must follow
2. Read `constitution/ANTIPATTERNS.md` — what NOT to do
3. Read `CHANGELOG.md` — check the current phase and what's in scope
4. Check `governance/changelog/ROADMAP.md` for the active phase
5. Search `docs/` and `governance/skill-evals/` for relevant prior work

---

## The eight principles (summary)

DevOPs adopts the four Karpathy principles plus four DevOPs extensions:

1. **Think Before Coding** — ask, don't assume
2. **Simplicity First** — minimum code, no speculative abstractions
3. **Surgical Changes** — every changed line traces to user request
4. **Goal-Driven Execution** — define success criteria, loop until verified
5. **Verifiable Claims (Proof of Work)** — every claim ships with proof
6. **Surgical Honesty Across Tool Handoffs** — baton protocol, no context loss
7. **Client Boundary Discipline** — zero cross-client operations
8. **Spec-Anchored Implementation** — every commit traces to `/specs/`

Read `constitution/PRINCIPLES.md` for full text, tradeoffs, and working signals.

---

## Pull request rules

1. **Every PR must trace to a spec or ADR.** No "while I was here" changes.
2. **Conventional Commits required** for the PR title, which becomes the
   squash commit's subject on `main` (the repository squash-merges with the
   PR title and the PR description). Format: `<type>(<scope>): <subject>`, scope optional.
   - Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`,
     `security`, `spec`, `ci`, `build`, `evals`, `fixture`, `audit`, `revert`
   - The `PR title` check (`.github/workflows/pr-title.yml`) enforces this.
3. **Every code change must include tests.** No exceptions for "small" changes.
   See [docs/TESTING.md](docs/TESTING.md) for the test layers and the
   flaky-test policy.
4. **Every PR must include proof in its PR description.** `.workflow/proofs/`
   is gitignored, so do not commit files from it; paste the proof into the
   PR description instead:
   - Test command run + exit code + output tail
   - Git diff
   - Spec reference
5. **No skill modifications without an eval pass.** Skills must demonstrate
   the "working when" signal documented in their metadata.
6. **All security-sensitive changes require a threat-model update** in
   `docs/SECURITY.md` or the relevant threat model under `docs/threat-models/`.

---

## Per-PR review checklist (author + reviewer)

Every PR runs through these review steps before squash-merge. Author runs
the local pre-flight; CI runs the gating pieces; reviewer confirms.

### Author pre-flight (before opening the PR)

| Step | Mechanism | What it checks |
|---|---|---|
| 1 | Claude Code `/code-review` (in-session) | Diff correctness, style, surgical scope, spec tracing. Author-driven, ad-hoc. Run before pushing the PR branch. |
| 2 | Claude Code `/security-review` (in-session) | Security-focused diff review. Catches obvious issues before CI does. Optional if the PR is non-security-touching, but cheap insurance. |
| 3 | `npm run validate:claims -- path/to/claim.yml --no-rerun` | New claim schema, Git provenance, and reproducibility hash. Re-run its recorded test when the required environment is available. |
| 4 | `cd stratum && npm run lint && npm run typecheck` (for Stratum code) | Lint and typecheck clean. |
| 5 | Test suite for the touched subtree: `npm test` (root) or `cd stratum && npm test`. | Relevant behavior passes before opening the PR. |

### CI checks (run on pull requests)

Branch protection on `main` requires the six checks marked "yes", and the
branch must be up to date with `main` before it merges.

| Check | Workflow | What it runs | Required |
|---|---|---|---|
| `validate` | `ci.yml` | Root test suite held to its floor; on PRs, the floor ratchet and an assertion check on added test files; claim and stale-proof validation; Renovate and skill lints | yes |
| `stratum-test` | `ci.yml` | Stratum typecheck and test suite, held to its floor | yes |
| `setup-linux` | `ci.yml` | Cold `npm run setup` on Linux in under 300 s, then the SQL integration tests against the local database | yes |
| `gitleaks` | `security-scan.yml` | Secret scan of the PR's commits | yes |
| `semgrep` | `security-scan.yml` | Semgrep registry rules; fails on findings, fatal errors or an empty scan | yes |
| `dependency-audit` | `security-scan.yml` | `npm audit` at high severity for the root and `stratum/`; dependency review on PRs | yes |
| `node-compat (24)`, `node-compat (26)` | `ci.yml` | The root suite and the Stratum typecheck and tests on newer Node majors | no |
| `deepteam` | `security-scan.yml` | DeepTeam red team when agent-behavior paths change. Without a provider key it skips visibly and gates nothing. | no |
| `Claude semantic security review` | `claude-security-review.yml` | Claude review of the diff, on non-draft PRs to `main` only. A missing `CLAUDE_API_KEY` produces a visible skip, not review evidence. See ADR-014. | no; inspect findings or skip status before merge |
| `Conventional Commits title` | `pr-title.yml` | The PR title follows rule 2 | no |

### Reviewer confirmation (before squash-merge)

- [ ] All CI checks green (or red findings addressed/waived in PR comments).
- [ ] Spec/ADR reference verified.
- [ ] Threat-model lint clean if any security-bearing file touched (see rule 6 above).
- [ ] Claim emission (if applicable) has a dated `.workflow/proofs/claim-*.yml` and matching test log.
- [ ] Polish-backlog updated if PB scope changed (new PB filed, existing PB closed, severity changed).

### Squash-merge convention

```bash
gh pr merge <N> --squash --delete-branch
```

`required_linear_history=true` is enforced by branch protection on `main` (per PB-17 closure). Direct commits to `main` are disallowed; every change lands via PR. The squash commit takes the PR title as its subject and the PR description as its body (repository settings `squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=PR_BODY`).

---

## Adding a new skill

1. Create the directory: `skills/<universal-or-stack-specific>/<category>/<skill-name>/`
2. Create `SKILL.md` with required YAML frontmatter:
   ```yaml
   ---
   name: skill-name
   description: One-line description. When to use. What it does. Be pushy to combat under-triggering.
   ---
   ```
3. Keep the body under 500 lines; use `references/` for longer material.
4. State the **tradeoff** at the top (Karpathy pattern).
5. State the **working when** signal at the bottom (Karpathy pattern).
6. Add an entry to `governance/skill-evals/registry.yml` with at least three
   test prompts the skill should pass.

---

## Adding a new hook

1. Create the script in `hooks/<universal-or-stack-specific>/<lifecycle>/`
2. The hook MUST exit cleanly. Hooks that hang block the agent forever.
3. The hook MUST log to `.workflow/state/events.jsonl` (one JSON line per event).
4. Pre-tool and post-tool hooks must complete in under 500ms (p99).
5. Document the hook in `docs/HOOKS.md`.

---

## Adding a new mode

1. Create `modes/<mode-name>/MODE.md`.
2. State the **purpose** — when this mode should be active.
3. State the **rule overrides** — what differs from the default behavior.
4. State the **acceptance gates** — what must be true to exit this mode.

---

## Versioning

DevOPs uses SemVer. Projects can lock to a specific version via
`.workflow/devops-version`. Workflow updates do not auto-apply mid-project.

---

## Security

If you discover a security issue, do NOT open a public issue. Report it
through GitHub private vulnerability reporting
(<https://github.com/MILTONADINA/DevOPs/security/advisories/new>). See
`docs/SECURITY.md` for the disclosure protocol, including what to do before
the repository owner has enabled private reporting.

Conduct in all project spaces is covered by `CODE_OF_CONDUCT.md`.
