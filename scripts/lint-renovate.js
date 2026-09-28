#!/usr/bin/env node
// scripts/lint-renovate.js
//
// CI lint gate for templates/renovate/renovate.json. Validates AC-H1.1 through
// AC-H6.1 from specs/phase-2/H-renovate-template.md. Tracked (vs. the
// gitignored .workflow/proofs/_checks/req-H1-H6-renovate-template.js sibling
// which serves the local claim-050 re-run path) so CI can invoke it without
// needing local proof artifacts on disk.
//
// Usage:
//   npm run lint:renovate
//   node scripts/lint-renovate.js [path-to-template]
//
// Exit 0 PASS, non-zero FAIL with a named defect on stderr.

import { readFileSync, statSync } from 'node:fs';

const path = process.argv[2] || 'templates/renovate/renovate.json';

let st;
try { st = statSync(path); } catch (e) { console.error('FAIL: ' + path + ' -- ' + e.message); process.exit(1); }
if (!st.isFile()) { console.error('FAIL: not a file: ' + path); process.exit(1); }

let obj;
try { obj = JSON.parse(readFileSync(path, 'utf-8')); }
catch (e) { console.error('FAIL: JSON parse error: ' + e.message); process.exit(1); }

const failures = [];

// REQ-H1 (AC-H1.1): top-level is an object
if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
  failures.push('REQ-H1: top-level value is not a JSON object');
}

// REQ-H2 (AC-H2.1): extends contains "config:recommended"
if (!Array.isArray(obj.extends) || !obj.extends.includes('config:recommended')) {
  failures.push('REQ-H2: extends array does not contain "config:recommended" (got: ' + JSON.stringify(obj.extends) + ')');
}

// REQ-H3 (AC-H3.1): schedule matches the weekly-window regex
const scheduleRe = /before \d+(:\d+)?\s*(am|pm) on .+day/i;
const scheduleValues = Array.isArray(obj.schedule) ? obj.schedule : [];
const hasWeeklyWindow = scheduleValues.some(s => typeof s === 'string' && scheduleRe.test(s));
if (!hasWeeklyWindow) {
  failures.push('REQ-H3: schedule does not contain a weekly-window entry matching the AC regex (got: ' + JSON.stringify(obj.schedule) + ')');
}

// REQ-H4 (AC-H4.1): vulnerabilityAlerts overrides schedule + labels includes security
const va = obj.vulnerabilityAlerts;
if (typeof va !== 'object' || va === null) {
  failures.push('REQ-H4: vulnerabilityAlerts block missing or not an object');
} else {
  const vaSchedule = Array.isArray(va.schedule) ? va.schedule : [];
  if (!vaSchedule.includes('at any time')) {
    failures.push('REQ-H4: vulnerabilityAlerts.schedule does not include "at any time" override (got: ' + JSON.stringify(va.schedule) + ')');
  }
  const vaLabels = Array.isArray(va.labels) ? va.labels : [];
  if (!vaLabels.includes('security')) {
    failures.push('REQ-H4: vulnerabilityAlerts.labels does not include "security" (got: ' + JSON.stringify(va.labels) + ')');
  }
}

// REQ-H5 (AC-H5.1): >=1 packageRules entry with patch updateTypes + groupName
const rules = Array.isArray(obj.packageRules) ? obj.packageRules : [];
const patchRule = rules.find(r => {
  if (typeof r !== 'object' || r === null) return false;
  const updateTypes = r.matchUpdateTypes || r.updateTypes;
  if (!Array.isArray(updateTypes) || !updateTypes.includes('patch')) return false;
  return typeof r.groupName === 'string' && r.groupName.length > 0;
});
if (!patchRule) {
  failures.push('REQ-H5: no packageRules entry has (matchUpdateTypes|updateTypes) including "patch" + a non-empty groupName');
}

// REQ-H6 (AC-H6.1): enabledManagers includes the 4 required managers minimum
const requiredManagers = ['npm', 'pip_requirements', 'cargo', 'gomod'];
const enabled = Array.isArray(obj.enabledManagers) ? obj.enabledManagers : null;
if (enabled === null) {
  const hasExplanatoryComment = typeof obj.$comment === 'string' && /enabled managers|all managers/i.test(obj.$comment);
  if (!hasExplanatoryComment) {
    failures.push('REQ-H6: enabledManagers absent AND no $comment explains why all managers are intentionally enabled');
  }
} else {
  const missing = requiredManagers.filter(m => !enabled.includes(m));
  if (missing.length > 0) {
    failures.push('REQ-H6: enabledManagers missing required managers: ' + missing.join(', ') + ' (got: ' + JSON.stringify(enabled) + ')');
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error('FAIL: ' + f);
  console.error('');
  console.error('Renovate template lint: ' + failures.length + ' check(s) failed against ' + path);
  process.exit(1);
}

console.log('PASS: ' + path + ' satisfies AC-H1.1 through AC-H6.1');
console.log('      extends=' + JSON.stringify(obj.extends));
console.log('      schedule=' + JSON.stringify(obj.schedule));
console.log('      vulnerabilityAlerts.schedule=' + JSON.stringify(va.schedule) + ', labels=' + JSON.stringify(va.labels));
console.log('      ' + rules.length + ' packageRules (groups: ' + rules.filter(r => r.groupName).map(r => r.groupName).join(', ') + ')');
console.log('      enabledManagers=' + JSON.stringify(enabled));
