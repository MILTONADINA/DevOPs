---
name: surgical-edits
description: Enforce the rule that every changed line must trace to a user request or spec line. Use during any code modification - no drive-by refactoring, no "while I was here" improvements, no formatting changes adjacent to actual work. The claim-validator rejects diffs containing untraceable lines. Counters the Rogue Actions failure mode (30.3% of incidents).
---

# Surgical Edits

> Implements Principle 3. Touch only what you must.

**Tradeoff:** Adjacent imperfect code stays imperfect. Worth it: every unrelated
change introduces risk that compounds. PR review focuses on intent, not noise.

---

## Rules

### When editing existing code
1. Don't "improve" adjacent code, comments, or formatting.
2. Don't refactor things that aren't broken.
3. Match existing style — even if you'd do it differently.
4. If you notice unrelated dead code, MENTION it in the session summary; do not delete it.

### When your changes create orphans
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

### Traceability test
Every changed line must answer: "Why is this line in this diff?"
Valid answers:
- "Implements REQ-N from spec section X"
- "Fixes the failing test added in task T-NNN"
- "Removes an import the previous change orphaned"
- "User explicitly requested this change in turn N"

Invalid answers:
- "It looked cleaner"
- "I happened to notice it"
- "While I was here"
- "Standard practice"

---

## Diff hygiene

Before claiming a task complete:

1. `git diff` — read every changed line aloud (mentally). Each one must trace.
2. If any line doesn't trace, revert it. The claim-validator will reject the
   diff anyway.
3. Reorder hunks for human review: dependencies before dependents.
4. Squash trivial fixup commits before merge.

---

## Auto-formatting interaction

`hooks/universal/post-tool/auto-format.sh` runs after every write. Format
changes from this hook are exempt from the traceability rule (they trace to
"formatter ran"). But if the formatter is making large changes, the file was
not consistently formatted to begin with — flag it but don't fix it as part
of an unrelated change.

---

## Example (correct surgical edit)

User: "Fix the typo on line 42 — 'recieve' should be 'receive'."

Correct diff:
```diff
- // recieve the webhook payload
+ // receive the webhook payload
```

Incorrect "while I was here" diff:
```diff
- // recieve the webhook payload
+ // receive the webhook payload
- function processWebhook(payload) {
-   if (payload) {
-     const result = doStuff(payload);
-     return result;
-   }
-   return null;
- }
+ function processWebhook(payload?: WebhookPayload): Result | null {
+   if (!payload) return null;
+   return doStuff(payload);
+ }
```

The second diff is rejected. The user asked for a typo fix, not a refactor.

---

**This skill is working when:** PR review comments asking "why did you change
this?" trend toward zero. Track diff-line traceability in
`governance/telemetry/trace-rate.jsonl`.
