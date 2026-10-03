---
name: emit-claim
description: Author a local claim, record a known check result and validate the emitted file as metadata with --no-rerun. Committed-set publication is separate. User-only; see verification/claim-schema.yml for the canonical schema.
disable-model-invocation: true
---

# /emit-claim

Authors and emits a verification claim per the DevOPs anti-hallucination floor discipline.

## Usage

```
/emit-claim <spec-ref-or-task-description>
```

Examples:

```
/emit-claim specs/meta/session-15-q4-base-url-wiring.md
/emit-claim "v0.3.x §2a code-side gap closure"
/emit-claim P0-A vitest migration complete
```

## What this command does

Wraps the claim-emission ritual:

### Step 1 — Authorize spec_ref

- If user gave a path under `specs/...` → use that as `spec_ref`
- Else (e.g., free-text description) → prompt user to either:
  - (a) point to an existing spec file under `specs/...`
  - (b) author a new meta-spec at `specs/meta/<session-N>-<slug>.md`
- The packaged schema requires a `specs/...md` path with an optional fragment.
  Committed-set validation additionally requires a fragment present in the target snapshot.

### Step 2 — Identify files_changed

- Compute via `git diff --name-only HEAD` (since last commit on current branch) OR
- User-explicit list of files to claim against
- Local explicit-file validation checks that these names appear in the target
  commit's changed-name list. Committed validation additionally requires regular
  blobs and first-parent change membership; do not describe the local check as that stronger gate.

### Step 3 — Author structural check

- Identify what acceptance criteria the claim asserts
- Author check script at `.workflow/proofs/_checks/req-<slug>.js` (Node ESM)
- Check assertions must be METHODOLOGY-based (not frozen figures), because a frozen figure breaks on the next legitimate refresh
- This ritual requires an observed passing check. The schema only constrains
  the declared exit to an integer; validation alone does not observe it.

### Step 4 — Run check + capture log

```bash
node .workflow/proofs/_checks/req-<slug>.js > .workflow/proofs/claim-YYYY-MM-DD-<NNN>-test.log 2>&1
echo "EXIT=$?"
```

EXIT must be 0 to proceed.

### Step 5 — Compute reproducibility_hash + assemble YAML

```bash
node -e "
const crypto = require('node:crypto');
const cmd = 'node .workflow/proofs/_checks/req-<slug>.js';
const env = {};
const sortedEnv = Object.keys(env).sort().map(k => k+'='+env[k]).join('\n');
const gitSha = '<post-commit-SHA>';
const input = cmd + '\n---\n' + sortedEnv + '\n---\n' + gitSha;
console.log('sha256:' + crypto.createHash('sha256').update(input).digest('hex'));
"
```

Write the YAML to `.workflow/proofs/claim-YYYY-MM-DD-<NNN>.yml` matching `verification/claim-schema.yml`:

```yaml
claim:
  id: claim-YYYY-MM-DD-<NNN>
  type: implementation
  spec_ref: specs/...
  description: '...'
  proof:
    git_sha: <SHA>
    files_changed:
      - ...
    test_command: node .workflow/proofs/_checks/req-<slug>.js
    test_exit_code: 0
    test_output_path: .workflow/proofs/claim-YYYY-MM-DD-<NNN>-test.log
  confidence: high
  reproducibility_hash: sha256:<HASH>
  timestamp: 'YYYY-MM-DDTHH:MM:SSZ'
```

### Step 6 — Validator run + close

```bash
npm run validate:claims -- ".workflow/proofs/claim-YYYY-MM-DD-NNN.yml" --no-rerun
```

Pass only the just-emitted explicit file(s), quoting each real filename as one
argument. This validates local schema/Git/hash metadata without executing the
claim's command or requiring a committed manifest. Record any validation
failure honestly; an exception note does not turn failure into acceptance.

Emission is not committed-set publication. Publishing requires a separately
reviewed manifest plus named YAML/scripts/checks, exact hashes and a commit;
logs stay ignored. Only then use `--all --no-rerun` or
`--claim <id> --no-rerun` for the committed gate. Omitting `--no-rerun` from
legacy local mode still enables unsafe raw shell replay. Metadata acceptance
does not establish the observed check result recorded in Step 4.

If validator regresses → STOP + surface (per AP-5 Reflexive Patch discipline).

## Conventions enforced by this command

- **Claim ID** is `claim-YYYY-MM-DD-NNN`: the emission date plus the next free NNN in `.workflow/proofs/` (the pattern `verification/claim-schema.yml` enforces).
- **`spec_ref` MUST start with `specs/`** per claim-validator gate.
- **`files_changed` MUST be in `git show --name-only <git_sha>`** per validator gate. Use `git_sha` of the squash-merged main SHA after PR merge for portability.
- **`reproducibility_hash`** uses the canonical algo from `verification/reproducibility-check.ts`: `sha256({test_command}\n---\n{sortedEnv}\n---\n{git_sha})` where `sortedEnv` is empty when no `claim.proof.environment` is set.
- **Check scripts MUST use methodology assertions** not frozen-figure assertions (frozen-figure checks rot on every refresh).

## Anti-patterns this command prevents

- **Squash provenance errors**: a squashed candidate may remain in the local
  object store but fail the committed gate's main-ancestry check. Preserve the
  original claim and evidence. Issue a truthful new claim tied to the appropriate
  target and actual observations; never retarget an old claim by changing its SHA.
- **Hand-computed hash mistakes**: wrong env algorithm → validator says `hash mismatch`.
- **Frozen-figure check rot**: hardcoding "v0.2.0 = 90%" in a check means the check breaks on every LR refresh; assert the methodology instead.
- **Forgetting the test log**: retain the actual local output from Step 4.
  Validation checks the declared path's shape, not log existence or contents;
  committed CI intentionally does not require the ignored log.

## When to use vs not use

**Use `/emit-claim`** when:
- Closing a Phase
- Closing a major feature within a phase
- Closing a sub-area acceptance (P0-A target tier complete)

**Don't use `/emit-claim`** for:
- Trivial commits (1-line typo fixes, README updates)
- Carry-forward updates to gitignored state docs (baton, session-handoff, polish-backlog)
- Pre-flight checks (use `/verify-claims` instead)
- Status reporting (use `/launch-readiness`)

## Cross-references

- `verification/claim-schema.yml` — canonical claim schema
- `verification/claim-validator.ts` — the validator
- `verification/reproducibility-check.ts` — hash algorithm
- `.workflow/proofs/_checks/` — existing check scripts as examples
- `slash-commands/universal/verify-claims.md` — committed metadata validation
- `subagents/universal/validator.md` — the independent re-verification role
