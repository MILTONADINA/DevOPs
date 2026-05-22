---
name: verify-claims
description: Re-run all claim proofs in .workflow/proofs/ and report which pass/fail. Use before merge, before declaring a session done, and as part of CI on every PR.
---

# /verify-claims

```bash
node verification/claim-validator.js --all
```

Optional flags:
- `--no-rerun` to check schema + git only (fast)
- `--session <id>` to validate one session
