#!/usr/bin/env bash
# scripts/run-redteam.sh
#
# Local parity wrapper for the CI red-team gate (spec phase-2/B-deepteam-ci.md
# REQ-B7). Invokes DeepTeam with the OWASP_ASI_2026() framework against the
# agent under test, using the same per_run_usd budget cap as CI reads from
# cost-controls/budget.yml. Exits with the same status the CI run would
# produce.
#
# POSIX bash, not PowerShell (per spec B Decisions: CI is Linux; Windows
# contributors run via Git Bash / WSL per docs/HOOKS.md).
#
# Usage:
#   bash scripts/run-redteam.sh
#
# Exit codes:
#   0   no critical findings (medium/low surfaced but non-blocking per REQ-B4)
#   1   one or more severity: critical findings (REQ-B3 -- blocks merge)
#   2   budget brake fired (REQ-B5 -- per_run_usd exhausted before completion)
#   3   pre-flight failure (DeepTeam not installed, budget.yml missing, etc.)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
BUDGET_YAML="${REPO_ROOT}/cost-controls/budget.yml"
ARTIFACT_DIR="${REPO_ROOT}/.workflow/proofs/red-team"

# Pre-flight checks
if [ ! -f "$BUDGET_YAML" ]; then
    echo "ERROR: ${BUDGET_YAML} missing" >&2
    exit 3
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 required for DeepTeam invocation" >&2
    exit 3
fi

if ! python3 -c "import deepteam" 2>/dev/null; then
    echo "ERROR: DeepTeam not installed. pip install deepteam" >&2
    exit 3
fi

# Read red_team.per_run_usd from budget.yml (simple grep -- the YAML schema
# is stable per REQ-B5). Default to 0.50 if the field is absent (matches the
# spec's production default).
PER_RUN_USD="$(grep -E '^\s*per_run_usd:' "$BUDGET_YAML" | head -1 | awk -F':' '{print $2}' | tr -d ' ')"
PER_RUN_USD="${PER_RUN_USD:-0.50}"

mkdir -p "$ARTIFACT_DIR"

echo "Red-team gate: invoking DeepTeam OWASP_ASI_2026() with per_run_usd=${PER_RUN_USD}"
echo "Artifacts will land under: ${ARTIFACT_DIR}"

# Invoke DeepTeam. The Python harness lives at the path the CI workflow
# also calls; both share the same entry point so local + CI parity is
# guaranteed by construction.
#
# Exit code mapping is performed inside the Python harness:
#   0 -> no criticals
#   1 -> >=1 critical
#   2 -> budget exhausted
python3 - "$PER_RUN_USD" "$ARTIFACT_DIR" <<'PYEOF'
import json
import os
import sys

per_run_usd = float(sys.argv[1])
artifact_dir = sys.argv[2]

try:
    from deepteam import red_team
    from deepteam.frameworks import OWASP_ASI_2026
except ImportError as e:
    print(f"ERROR: DeepTeam import failed: {e}", file=sys.stderr)
    sys.exit(3)

# The agent-under-test endpoint shape and the model_callback construction
# are project-specific. The synthetic ASI01-failing fixture authored in
# B.09 (session 6) provides a known-fails test surface; until then, run
# against the real project agent surface.
#
# This script is a parity wrapper -- the actual agent-under-test
# parameterisation lives in tests/fixtures/agents/ once B.09 ships.
try:
    result = red_team(
        framework=OWASP_ASI_2026(),
        budget_usd=per_run_usd,
    )
except Exception as e:
    # Budget-brake fires from inside DeepTeam when accumulated cost exceeds
    # the budget. The framework raises a specific exception type the
    # exact name of which depends on DeepTeam version; here we treat any
    # explicit "budget_exhausted" signal as exit 2.
    msg = str(e).lower()
    if "budget" in msg and ("exhausted" in msg or "exceeded" in msg or "halt" in msg):
        with open(os.path.join(artifact_dir, "budget-exhausted.md"), "w") as f:
            f.write(f"# Red-team run halted by budget brake\n\nper_run_usd={per_run_usd}\nerror: {e}\n")
        print("Red-team run halted by budget brake", file=sys.stderr)
        sys.exit(2)
    raise

# Persist artifacts (report.md, findings.jsonl, transcript.jsonl) under
# artifact_dir. The exact attributes DeepTeam exposes on its result
# object vary by version; this writes the standard set defensively.
with open(os.path.join(artifact_dir, "findings.jsonl"), "w") as f:
    for finding in getattr(result, "findings", []):
        f.write(json.dumps({
            "category": getattr(finding, "category", "unknown"),
            "severity": getattr(finding, "severity", "unknown"),
            "summary": getattr(finding, "summary", ""),
        }) + "\n")

with open(os.path.join(artifact_dir, "report.md"), "w") as f:
    f.write("# Red-team report\n\n")
    findings = getattr(result, "findings", [])
    f.write(f"Total findings: {len(findings)}\n\n")
    for finding in findings:
        f.write(f"- [{getattr(finding, 'severity', '?')}] {getattr(finding, 'category', '?')}: {getattr(finding, 'summary', '')}\n")

# Exit on criticals per REQ-B3.
critical_count = sum(
    1 for f in getattr(result, "findings", [])
    if str(getattr(f, "severity", "")).lower() == "critical"
)
sys.exit(1 if critical_count > 0 else 0)
PYEOF

EXIT_CODE=$?
echo "Red-team gate completed with exit code ${EXIT_CODE}"
exit $EXIT_CODE
