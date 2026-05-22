# Debug-Prod Mode

## When to activate

- Investigating a production issue
- NO changes yet — find the cause first

## Rules — READ-ONLY BY DEFAULT

- All file writes blocked except in `.workflow/state/investigation-notes.md`
- All deploy commands blocked
- Schema modifications blocked
- Agent gathers evidence; human authorizes changes

## Output

- `.workflow/state/investigation-notes.md` — running notes
- `.workflow/state/proposed-fix.md` — once root cause is understood

## Transition

Once the user approves the proposed fix, transition to hotfix mode.
