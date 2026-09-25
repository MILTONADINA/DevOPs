---
name: verify-claims
description: Re-run all claim proofs in .workflow/proofs/ and report which pass/fail. Use before merge, before declaring a session done, and as part of CI on every PR.
---

# /verify-claims

```bash
npm run validate:claims -- --all
```

Run it from the DevOPs repo root. In a project that installed DevOPs, run the
same validator from that project's root (it reads `.workflow/proofs/` there),
with `DEVOPS_ROOT` set to the DevOPs checkout when it is not at `~/DevOPs`:

```bash
npx --yes tsx "${DEVOPS_ROOT:-$HOME/DevOPs}/verification/claim-validator.ts" --all
```

Options (append to either form):
- `--no-rerun` to check schema + git only (fast)
- pass claim files (`.workflow/proofs/claim-*.yml`) instead of `--all` to validate only those
