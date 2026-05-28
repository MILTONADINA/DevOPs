# ADR-014: Wire `anthropics/claude-code-security-review` GitHub Action as PR-gating security review

**Spec ref**: `plan.md §2f` (v0.3.x first-party Anthropic integrations) + `specs/meta/session-15-v0.3x-2f-anthropic-integrations.md`
**Companion artifact**: `.github/workflows/claude-security-review.yml`
**Numbering note**: governance/decisions/ sequence starts at ADR-014 per plan.md guidance. The pre-existing `docs/decisions/0001-0007` ADRs and `stratum/docs/decisions/0008` are separate sequences (Startum-scaffold-era and stratum-subtree respectively). The 014 number is opaque (Phase-2 audit absorbed prior gap) and intentionally non-contiguous; subsequent governance/ ADRs continue from 015.

## Status

**Accepted** (Session 15, 2026-05-28). Landed on `main` via PR #18 at squash-merge SHA `9cfcc75`.

## Context

The DevOPs masterpiece envelope (per `blueprint.md §6` quality bar) requires production-grade security review on every change to `main`. Three review mechanisms exist:

1. **Manual `/code-review` (Claude Code CLI slash command)** — agent-side, ad-hoc, useful for in-session iteration but not a release gate.
2. **`/security-review` (Claude Code CLI slash command)** — agent-side, ad-hoc, useful for in-session iteration but not a release gate.
3. **`anthropics/claude-code-security-review` GitHub Action** — CI-side, runs on every PR, posts inline review comments, uploads results artifact.

Path (3) is the PR-gating mechanism. Paths (1) + (2) are author-driven pre-flight tools.

Pre-Session-15, the repo had:

- `.github/workflows/security-scan.yml` — runs `secrets-scan` (gitleaks), `static-analysis` (semgrep + dep-audit), `threat-model-validity` (custom). Pattern-matching + custom validation. Necessary but NOT semantic.
- `.github/workflows/release-sign.yml` — Sigstore/cosign signing on release tags.
- Manual `/security-scan` slash command — runs the tiered scan stack locally.

What was missing: **AI-powered semantic security analysis** that goes beyond pattern matching to understand code intent. Especially load-bearing for skills + subagents + the cross-subtree wiring we just did in Session 15 §2a-2 (PII redaction consumption from observability/ into stratum/).

The Session 15 §2a-4 adversarial-test discipline caught a ReDoS bug in the email regex — that's a semantic security bug (unbounded greedy match → O(N²) backtracking on inputs without `@`). Pattern-matching scanners (gitleaks/semgrep) would not have caught it. Claude's semantic analysis would have, by reading the regex + reasoning about input shapes.

## Decision

Wire `anthropics/claude-code-security-review` as a PR-gating GitHub Action workflow at `.github/workflows/claude-security-review.yml`. Triggers on every `pull_request` to `main`. Posts inline review comments. Uploads results JSON as artifact.

### Specific configuration choices

1. **SHA-pin to upstream main @ `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` (2026-02-11)**. The upstream repository has no releases or tags published as of 2026-05-28 (verified via `gh api repos/anthropics/claude-code-security-review/releases/latest` returns 404; `gh api .../tags` returns empty). SHA-pinning per AST08 is therefore mandatory. Re-verify quarterly; bump when upstream publishes a release tag.

2. **`claude-model: claude-opus-4-7`** — the action's default is `claude-opus-4-1-20250805`; explicit override to the current latest Opus (`claude-opus-4-7`, per knowledge cutoff 2026-01) ensures the most capable model is used for security analysis. Cost differential is negligible for the value (security findings ROI dominates token spend).

3. **`comment-pr: true` + `upload-results: true`** — both defaults. Inline comments + artifact preservation is the canonical use pattern.

4. **`exclude-directories`** explicit list: `node_modules,dist,build,coverage,.workflow,.remember,docs/screenshots,stratum/data,stratum/coverage`. Reduces analysis scope to actual source code, not derived artifacts or local-only state. Keeps cost down + improves signal-to-noise.

5. **`claudecode-timeout: '20'`** — default. Bound analysis to 20 minutes per run.

6. **`if: ${{ github.event.pull_request.draft == false }}`** — don't run on draft PRs (avoid burning analysis cost on incomplete work). Maintainer can mark ready-for-review when the PR is in a reviewable state.

7. **Permissions: `contents: read` + `pull-requests: write`**. Minimum required scope. No `issues: write` (action only comments on PRs, not issues). No `actions: write` (no self-modification capability).

### Required secret

`CLAUDE_API_KEY` (Anthropic API key with both Claude API + Claude Code usage enabled). Configured at https://github.com/MILTONADINA/DevOPs/settings/secrets/actions. The workflow runs without the secret will result in API authentication failures from the action itself — there's no agent-side bypass.

**Bootstrap order**: this ADR + workflow lands BEFORE the secret is configured. The first PR after merge that lacks the secret will surface the failure-mode to the user, who then configures the secret out-of-band. Subsequent PRs run normally.

## Consequences

### Positive

- **Every PR gets semantic security review** before merge to `main`. Production-grade rigor baked into CI, not gated on author discipline.
- **Inline comments** surface findings at the code location, lowering remediation friction.
- **Findings artifact** preserved for post-merge audit + claim-validator integration (potential future: feed findings count into a claim-validator gate).
- **Catches semantic bugs** that pattern-matching scanners miss (Session 15 §2a-4 ReDoS bug is the canonical example).
- **No competing slash-command name collision** — Anthropic's `/security-review` is a Claude Code CLI slash command (in-session); our `/security-scan` is a DevOPs CLI slash command (runs the tiered scan stack). Different surfaces, no collision. Documented in `slash-commands/README.md` (separate §2f Task 3 deliverable).

### Negative

- **Cost per PR**: Opus 4.7 analysis of diff is non-trivial. Bounded by `claudecode-timeout: 20` (max 20min of analysis) + `exclude-directories` (focuses on real code). For solo-dev v0.2.x repo with ~1-2 PRs per session, cost should stay well under $5 per PR. Re-evaluate cost trajectory at v0.4.x when MCS subagent autonomous loops are landing (PR volume could spike).
- **Prompt-injection caveat** per upstream README: the action is NOT hardened against prompt-injection attacks. Repo is private (solo-dev + Dependabot) until v0.8.x friends-install; risk surface bounded. **When the repo opens up, this workflow MUST be paired with branch-protection "Require approval for all external contributors" workflow-run gating.** Flagged here as a v0.8.x precondition.
- **External dependency on `CLAUDE_API_KEY` validity**. Key rotation must be coordinated. The action will fail noisily on auth errors; no silent failure mode.
- **SHA pin churn**: upstream has no release cadence yet; quarterly SHA re-verification is a manual governance task. When upstream publishes a release tag, the pin discipline simplifies (tag SHA → release SHA).

### Neutral

- The action is path-3 (CI-gated); paths 1 and 2 (manual `/code-review` + `/security-review`) remain available for in-session use. They complement, not replace, CI gating.
- Existing `security-scan.yml` workflow (gitleaks + semgrep + threat-model-validity) STAYS in place. The Claude action ADDS semantic analysis on top of pattern matching; it does not replace pattern matching. Both layers are load-bearing.

## Re-verification triggers (forward-looking)

1. **Quarterly**: re-check `gh api repos/anthropics/claude-code-security-review/commits/main` for new SHA. Bump pin if upstream has security-relevant updates. Test on a no-op PR before bumping prod.
2. **At first published release tag**: switch SHA pin from main-branch-commit to release-tag-commit. Update this ADR + workflow comment.
3. **At v0.8.x friends-install milestone**: pair this workflow with branch-protection external-contributor gating. Update `governance/policies/external-prs.md` (TBD).
4. **At cost-spike incident**: if a single PR's analysis exceeds ~$10 (e.g., very large diff + slow model), reduce `claudecode-timeout` or add stricter `exclude-directories` to constrain scope.
5. **At known false-positive pattern**: configure `false-positive-filtering-instructions` pointing to a `governance/security/fp-filter.txt` file.

## Alternatives considered

1. **Manual `/security-review` only** (no CI gating): rejected — relies on author discipline; not enforceable as a release gate.
2. **Pattern-matching scanners only** (status quo gitleaks/semgrep): rejected — misses semantic bugs (Session 15 ReDoS catch is the proof). Pattern matching is a load-bearing FLOOR, not a CEILING.
3. **In-house Claude API wiring** (custom workflow that calls Anthropic API directly): rejected — reinvents the action; loses upstream maintenance + improvements; SHA-pinning third-party is honest about the trust relationship.
4. **Wait for Anthropic to publish a release tag** before integrating: rejected — production-grade rigor TODAY beats waiting for upstream cadence. SHA-pin to main is the standard pattern for unreleased actions; quarterly re-verification absorbs the upstream-stability tradeoff.

## References

- Upstream repository: https://github.com/anthropics/claude-code-security-review
- Anthropic blog post: https://www.anthropic.com/news/automate-security-reviews-with-claude-code
- AST08 SHA-pinning discipline: `governance/AST08-action-sha-pinning.md` (or equivalent — convention enforced across `.github/workflows/*.yml`)
- PB-12, PB-14 closures (action SHA-pinning regression fixes): `.workflow/state/polish-backlog.md`
- Session 15 §2a-4 ReDoS bug fix (semantic security bug caught by adversarial test, not by pattern matching): `observability/pii-redaction.ts` commit `4fd8917` on `stratum-phase-0-capture`
