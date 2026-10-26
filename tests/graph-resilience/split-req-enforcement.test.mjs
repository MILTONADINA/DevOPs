// Spec-conformance checks for the mixed REQs that were split into a mechanical half (original id,
// enforced by a test) and a procedural half (next free id, PROCESS). The behaviour of each mechanical
// half is exercised by the cited test files; this file pins the split itself: which clauses stay in
// the original, which moved, that the procedural twin is PROCESS, and that each cited file really has
// a test titled for the REQ. Synthetic only; reads specs, writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const R = 'specs/graph/R-resilience.md';
const M = 'specs/graph/M-masterpiece-standard.md';

// The body of one REQ section: from its heading to the next heading or horizontal rule.
function section(file, id) {
  const lines = read(file).split('\n');
  const start = lines.findIndex((line) => new RegExp(`^### ${id}\\b`).test(line));
  assert.ok(start >= 0, `${id} is missing from ${file}`);
  let end = start + 1;
  while (end < lines.length && !/^(### |## |---$)/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}
const enforcedBy = (body) => /^\*\*Enforced by:\*\* (.+)$/m.exec(body)?.[1];

const SPLITS = [
  { file: R, id: 'REQ-R4', twin: 'REQ-R17', tests: ['tests/graph-resilience/req-contracts.test.mjs'],
    kept: [/`sprint-cycle\.js` starts/, /`BLOCKED_BY_ENVIRONMENT:`/], moved: [/`\/sprint` is invoked/, /exit 20 or 2/] },
  { file: R, id: 'REQ-R7', twin: 'REQ-R18', tests: ['tests/graph-resilience/req-contracts.test.mjs'],
    kept: [/ENVIRONMENT RULES/, /STALL RULES/, /optional `blocked_by_environment`/], moved: [/graph-preflight\.sh` once/, /SHALL NOT set `passed: true`/] },
  { file: R, id: 'REQ-R9', twin: 'REQ-R19', tests: ['tests/graph-resilience/blocked.test.mjs', 'tests/graph-resilience/req-contracts.test.mjs'],
    kept: [/scripts\/graph-blocked\.sh/, /\*\*Run record\*\*/, /gitignored/], moved: [/before returning/, /removed only by `\/sprint --resume`/] },
  { file: R, id: 'REQ-R10', twin: 'REQ-R20', tests: ['tests/graph-resilience/run-record.test.mjs', 'tests/graph-resilience/resume-args.test.mjs', 'tests/graph-resilience/req-contracts.test.mjs'],
    kept: [/priorRunIds/, /graph-resume-args\.mjs/, /graph-run-record\.mjs launch/], moved: [/`\/sprint` call `graph-run-record\.mjs launch`/] },
  { file: M, id: 'REQ-M7', twin: 'REQ-M31', tests: ['tests/graph-resilience/workflow-faults.test.mjs', 'tests/graph-resilience/req-contracts.test.mjs', 'tests/graph-resilience/run-record.test.mjs'],
    kept: [/AMBIGUITY_BLOCK:/, /`conflicts: \[\{higher, lower, clause\}\]`/, /owner decision > law\/safety/], moved: [/only from the owner's answer/, /`needs_human` blocked record/] },
  // Second batch. A twin is PROCESS only where an orchestrator step is the whole clause; where the
  // moved clause names behaviour no code implements yet, the twin stays UNENFORCED.
  { file: M, id: 'REQ-M8', twin: 'REQ-M32', tier: 'UNENFORCED', tests: ['tests/graph/spec-status.test.mjs', 'tests/graph-resilience/split-req-mechanical.test.mjs'],
    kept: [/`scripts\/lint-spec-status\.mjs` in `ci\.yml`/, /`draft\|approved\|implemented\|superseded`/, /traceability-baseline\.json/], moved: [/graph-run-record\.mjs launch/, /`tasks\[\]\.ac_ids`/, /`outcome_ref`/] },
  { file: M, id: 'REQ-M9', twin: 'REQ-M33', tier: 'UNENFORCED', tests: ['tests/verification/claim-schema-loading.test.mjs', 'tests/verification/committed-claims.test.mjs', 'tests/graph-resilience/split-req-mechanical.test.mjs'],
    kept: [/loads and enforces `verification\/claim-schema\.yml`/, /`spec_ref` file and anchor exist/, /PB-60/, /requires `proof\.red/], moved: [/temporary worktree/, /`claim_id`/] },
  { file: M, id: 'REQ-M10', twin: 'REQ-M34', tier: 'UNENFORCED', tests: ['tests/verification/readiness-claims.test.mjs', 'tests/graph-resilience/split-req-mechanical.test.mjs'],
    kept: [/`state: enum \[implemented, verified, code_converged, release_ready, fixed_not_live, production_complete\]`/, /lint-readiness-claims\.mjs/], moved: [/`code_converged` without a `graph-converge\.mjs status`/, /deploy proof/] },
  { file: M, id: 'REQ-M14', twin: 'REQ-M35', tier: 'UNENFORCED', tests: ['tests/ci/assert-scan.test.mjs', 'tests/graph-resilience/split-req-mechanical.test.mjs'],
    kept: [/pinned `semgrep scan --json --error`/, /scripts\/assert-scan\.mjs/, /`paths\.scanned`/], moved: [/run-redteam\.sh/, /SKIPPED\.md/] },
  { file: M, id: 'REQ-M21', twin: 'REQ-M36', tier: 'UNENFORCED', tests: ['tests/verification/closure-references.test.mjs', 'tests/graph-resilience/split-req-mechanical.test.mjs'],
    kept: [/scripts\/lint-closures\.mjs/, /committed copies/], moved: [/sync-lr-refined-date\.sh/] },
];

for (const split of SPLITS) {
  test(`${split.id}: the mechanical half cites existing tests and keeps only its mechanical clauses`, () => {
    const body = section(split.file, split.id);
    const cited = enforcedBy(body);
    assert.ok(cited, `${split.id} has no Enforced by line`);
    assert.deepEqual(cited.split('; '), split.tests.map((file) => `test:${file}`));
    for (const file of split.tests) assert.ok(existsSync(path.join(ROOT, file)), `${file} does not exist`);
    // At least one cited file registers a test named for this REQ, so the citation is not decorative.
    const titled = split.tests.some((file) => new RegExp(`test\\([^\\n]*${split.id}\\b`).test(read(file)));
    assert.ok(titled, `no cited file has a test titled for ${split.id}`);
    for (const pattern of split.kept) assert.match(body, pattern);
    for (const pattern of split.moved) assert.doesNotMatch(body, pattern);
  });

  test(`${split.twin}: the procedural half is PROCESS or UNENFORCED, never mechanical, and carries the moved clauses`, () => {
    const body = section(split.file, split.twin);
    assert.equal(enforcedBy(body), split.tier ?? 'PROCESS');
    assert.match(body, new RegExp(`\\(${split.id}\\)`), `${split.twin} should name the REQ it was split from`);
    for (const pattern of split.moved) assert.match(body, pattern);
  });
}

test('split ids are appended after the last pre-existing id, so no REQ is renumbered', () => {
  const ids = (file) => [...read(file).matchAll(/^### (REQ-[A-Z]+\d+)\b/gm)].map((m) => m[1]);
  const rIds = ids(R);
  assert.deepEqual(rIds.slice(rIds.indexOf('REQ-R16')), ['REQ-R16', 'REQ-R17', 'REQ-R18', 'REQ-R19', 'REQ-R20']);
  const mIds = ids(M);
  assert.deepEqual(mIds.slice(mIds.indexOf('REQ-M30')), ['REQ-M30', 'REQ-M31', 'REQ-M32', 'REQ-M33', 'REQ-M34', 'REQ-M35', 'REQ-M36']);
});

test('the enforcement baseline lists every split REQ and none of the twins', () => {
  const baseline = JSON.parse(read('governance/enforcement-baseline.json')).enforced;
  for (const split of SPLITS) assert.ok(baseline.includes(`${split.file}#${split.id}`), `${split.id} missing from baseline`);
  for (const split of SPLITS) assert.ok(!baseline.includes(`${split.file}#${split.twin}`), `${split.twin} is not mechanical and must not be in the baseline`);
});
