# Contributing to DevOPs

DevOPs is built on a strict philosophy: every change must be justifiable,
verifiable, and surgical. This document is the rulebook.

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
2. **Conventional Commits required.** Format: `<type>(<scope>): <subject>`
   - Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`, `security`
3. **Every code change must include tests.** No exceptions for "small" changes.
4. **Every PR must include proof artifacts** in `.workflow/proofs/`:
   - Test command run + exit code + output tail
   - Git diff
   - Spec reference
5. **No skill modifications without an eval pass.** Skills must demonstrate
   the "working when" signal documented in their metadata.
6. **All security-sensitive changes require a threat-model update** in the
   relevant `docs/security/` document.

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

If you discover a security issue, do NOT open a public issue. Email the
maintainer directly. See `docs/SECURITY.md` for the disclosure protocol.
