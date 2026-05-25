# Double-consumption probe (AC-C6.3)

## Premise

Once an `approval_token` carries a `consumed_at` value, the next destructive
call referencing the same token must be rejected with
`approval token already consumed; obtain a new approval`.

## Scenario

After running `block-then-approve.md` Step 4 (token now has `consumed_at`):

```bash
# Repeat the destructive call WITHOUT issuing a new approval
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | bash hooks/universal/pre-tool/external-content-boundary.sh
# exit 1 — BLOCKED
# stderr: "BLOCKED: destructive call after rebuff block requires unconsumed approval_token..."
```

## Why this is load-bearing

Without the one-shot semantic, a single approval could be replayed indefinitely
within a session — defeating the purpose of the human gate. The
`consumed_at` timestamp + rewrite-on-consume in the pre-tool hook is the
enforcement mechanism.

## Inspecting the approvals file post-consumption

```bash
cat .workflow/state/approvals.jsonl
# {"timestamp":"...","claim_id":"...","approval_token":"...","entry_hmac":"...","consumed_at":"..."}
```

The `consumed_at` field is set ONLY by the pre-tool hook's Python step
during a successful consumption. Manual edits to add this field don't
work because they fail entry_hmac re-verification on the next attempt
(the hmac is keyed; can't be re-issued without the session key).
