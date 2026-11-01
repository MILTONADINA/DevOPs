# DevOPs Playbook

The operational guide. How to actually use DevOPs on a real project.

## Day 0 — install DevOPs on your machine

```bash
npm install -g @miltonadina/devops
devops version
```

The `devops` command reads from the installed package. Set `DEVOPS_ROOT` only
to point it at a checkout of the DevOPs repository instead.

## Day 1 — open an existing project

```bash
cd ~/my-project
devops analyze            # detect stack, write .workflow/profile.yml
cat .workflow/profile.yml # review recommendations
devops init --dry-run     # see what init would install
devops init               # install hooks, skills, subagents
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
devops analyze   # detects "greenfield" state
devops init
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
7. **Validate**: validate explicitly selected claim metadata with `--no-rerun`;
   review separately observed check results. The validator does not execute proofs.
8. **Summary**: `/session-summary` generates `.workflow/state/session-summary.md`
9. **Merge**: only after Validator says SAFE TO MERGE

## Session handoff (switching tools)

Hit your Claude plan's usage limit (the five-hour session limit or the weekly limit)? Want to switch to local LLM?

```
You: /checkpoint
```

Then open the next tool. At session start, `load-baton.sh` reports whether
`.workflow/state/baton.md` exists and how old it is; the agent reads the baton
and resumes from its `## Next action` section.

## Multi-client setup

One repo per client. Each has its own `.workflow/client/profile.yml`.
The client-boundary hook blocks Read, Write, Edit, MultiEdit, NotebookEdit, Glob
and Grep paths outside the project root (paths are normalised and symlinks
resolved first). It is not registered by default and does not inspect Bash
commands. Register it in `.claude/settings.json`; it reads the PreToolUse JSON
from stdin, so pass the input straight through with no `jq` wrapper. The
installer copies the hook to `<project>/.claude/hooks/client-boundary.sh`; in a
DevOPs checkout it lives at `hooks/universal/pre-tool/client-boundary.sh`. The
command below tries the installed path first, then the checkout path:

```json
{ "hooks": { "PreToolUse": [ {
  "matcher": "Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep",
  "hooks": [ { "type": "command",
    "command": "R=\"${CLAUDE_PROJECT_DIR:-.}\"; cd \"$R\" || exit 2; H=.claude/hooks/client-boundary.sh; [ -f \"$H\" ] || H=hooks/universal/pre-tool/client-boundary.sh; [ -f \"$H\" ] || { echo \"HOOK MISSING: $R/$H -- failing closed\" >&2; exit 2; }; bash \"$H\"" } ]
} ] } }
```

`.workflow/client/path-allowlist.txt` takes one literal absolute path per line.
Only a leading `~`, `$HOME` or `${HOME}` is expanded. A line with any other `$`,
a backtick, or a relative path is ignored with a warning, as is a `~`/`$HOME` line
when `HOME` is unset or relative. The hook needs `node`.

A leading `~` in a tool path is expanded with `HOME` (as the file tools do);
`~user/...` paths, and `~` paths while `HOME` is unset or relative, are blocked.
Every present path field of a call is checked. The global read-only list
includes `$HOME/.cache/`, which can hold other projects' checkouts or build
caches: it is a known exposure, so remove it from the hook's list if that
matters to you.

Limits: only `tool_input.file_path`, `path` and `notebook_path` are inspected, so
a Glob call with an absolute `pattern` and no `path`, and a Grep `glob`, are not
checked. `.workflow/client/path-allowlist.txt` and `.workflow/state/events.jsonl`
live inside the project root, so the agent can write them; protect the allowlist
with review, not with this hook. Relative paths resolve against the project root
(the hook's working directory), not the session's cwd. Every failure inside the
hook exits 2; a missing hook file or failed `cd` in the registration above also
exits 2 (a bare `cd ... && bash ...` would exit 1 or 127, which does not block).
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
- Inspect the committed metadata result with
  `npm run validate:claims -- --all --no-rerun`. A missing or empty manifest is
  a failure; this command does not discover local claims or execute tests.
- For a just-emitted local claim, name that file explicitly with `--no-rerun`.
  Local validation and the generated project hook do not publish a committed set.
- Correct the actual declaration, target, manifest or publication fault. If a
  fresh test is needed, review and run its known check separately, then record
  its observed result; never execute arbitrary claim text to repair metadata.
- Never hide a failure by editing proof fields. A recomputed hash binds declared
  strings and does not establish that a result was observed. Omission of
  `--no-rerun` is refused; the validator offers no command replay.

## Documentation map (Diataxis-aligned)

| Type | Location | Examples |
|------|----------|----------|
| Tutorials (learning) | `docs/PLAYBOOK.md` (this file), `docs/EARS_GUIDE.md` | "Your first feature with DevOPs" |
| How-to guides (problem-solving) | `docs/*.md` | "How to switch from Claude Code to Codex mid-session" |
| Reference (information) | `docs/HOOKS.md`, `docs/MODES.md` | "All available hooks and their interfaces" |
| Explanation (understanding) | `constitution/*`, `docs/SECURITY.md` | "Why the constitution exists" |
