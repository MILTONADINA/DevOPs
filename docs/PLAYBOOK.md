# DevOPs Playbook

The operational guide. How to actually use DevOPs on a real project.

## Day 0 — install DevOPs on your machine

```bash
git clone https://github.com/MILTONADINA/DevOPs.git ~/DevOPs
cd ~/DevOPs
./scripts/install.sh
```

Add to your shell rc (~/.bashrc, ~/.zshrc):
```bash
export DEVOPS_ROOT="$HOME/DevOPs"
export PATH="$DEVOPS_ROOT/scripts:$PATH"
```

## Day 1 — open an existing project

```bash
cd ~/my-project
analyze.sh                # detect stack, write .workflow/profile.yml
cat .workflow/profile.yml # review recommendations
init-project.sh           # install hooks, skills, subagents
```

Fill in the client profile:
```bash
cat > .workflow/client/profile.yml <<EOF2
name: acme-corp
data_classes: [PII, financial]
compliance_scope: [PCI DSS, GDPR]
pentest_authorization: ""  # add written-authorization reference here
EOF2
```

Open the project in your tool (Claude Code, Codex, Cursor, etc.). On session
start:

1. The session-start hook prints a status banner
2. Constitution is loaded
3. Baton is checked (none on first run)
4. Project profile is verified

## Day 1 — open a new project

```bash
mkdir my-new-project && cd my-new-project
git init
analyze.sh   # detects "greenfield" state
init-project.sh
```

Greenfield mode is auto-selected. The lifecycle phase is `discovery`. First
work: write user journeys, then EARS specs via `/ears-spec`.

## Writing a feature, end to end

1. **Spec**: `/ears-spec password-reset` produces `specs/auth/password-reset.md`
2. **Threat model**: `/threat-model password-reset` produces `docs/threat-models/password-reset.md`
3. **Plan**: the Planner subagent (Opus) decomposes the spec into atomic tasks
   at `.workflow/state/plans/auth-password-reset.md`
4. **Implement**: the Coder subagent (Sonnet) executes tasks via the goal-loop:
   write failing test → implement → verify → emit proof
5. **Review**: the Reviewer subagent (Sonnet) reads the diff against spec
6. **Security**: `/security-scan` runs the Tier 2 stack
7. **Validate**: the Validator subagent (Opus) re-runs all proofs
8. **Summary**: `/session-summary` generates `.workflow/state/session-summary.md`
9. **Merge**: only after Validator says SAFE TO MERGE

## Session handoff (switching tools)

Reached your Claude Code 5-hour limit? Want to switch to local LLM?

```
You: /checkpoint
```

Then open the next tool. The baton at `.workflow/state/baton.md` is read
automatically. The agent resumes from `next_action`.

## Multi-client setup

One repo per client. Each has its own `.workflow/client/profile.yml`.
The client-boundary hook blocks any file access outside the project root.
Cost ledgers are scoped per `tenant_id` (Stratum) for per-client invoicing.

## When things go wrong

### Loop detection fires
- Read `.workflow/state/blockers.md`
- Identify why the agent is stuck (usually: missing context, ambiguous spec)
- Resolve, then restart session

### Budget cap hits
- Review `.workflow/state/budget-ledger.jsonl`
- If the work justifies it, raise the cap in `.workflow/state/budget.yml`
- Or split the work across sessions (`/checkpoint` + resume tomorrow)

### Production write blocked
- Confirm the deploy is intended
- Run `/approve-prod-deploy` to write a 5-minute approval token
- Re-run the deploy command

### Claim validator fails
- Read which claim failed and why (`node verification/claim-validator.js --all`)
- Fix: re-run the test, update the proof, or retract the claim
- Never edit the proof to hide a failure — the validator will catch it via
  reproducibility hash mismatch

## Documentation map (Diataxis-aligned)

| Type | Location | Examples |
|------|----------|----------|
| Tutorials (learning) | `docs/PLAYBOOK.md` (this file), `docs/EARS_GUIDE.md` | "Your first feature with DevOPs" |
| How-to guides (problem-solving) | `docs/*.md` | "How to switch from Claude Code to Codex mid-session" |
| Reference (information) | `docs/HOOKS.md`, `docs/MODES.md` | "All available hooks and their interfaces" |
| Explanation (understanding) | `constitution/*`, `docs/SECURITY.md` | "Why the constitution exists" |
