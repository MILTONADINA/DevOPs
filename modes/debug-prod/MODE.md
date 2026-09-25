# Debug-Prod Mode

## When to activate

- Investigating a production issue
- NO changes yet — find the cause first

## Rules — READ-ONLY BY DEFAULT

- Write only `.workflow/state/investigation-notes.md`, plus
  `.workflow/state/proposed-fix.md` once the root cause is understood
- Run no deploy commands and no schema modifications
- Agent gathers evidence; human authorizes changes

No hook enforces mode rules, so these hold only while you keep them. Where the
host tool wires `hooks/universal/pre-tool/deploy-gate.sh`, it still gates
deploy commands, whatever the mode.

## Output

- `.workflow/state/investigation-notes.md` — running notes
- `.workflow/state/proposed-fix.md` — once root cause is understood

## Transition

Once the user approves the proposed fix, transition to hotfix mode.
