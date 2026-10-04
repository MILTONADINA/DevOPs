// specs/security/local-dast.md AC9: real, fresh internal positive-control run.
import assert from 'node:assert/strict';
import { runDast } from '../../scripts/run-dast.mjs';

try {
  assert.equal(process.argv.length, 2);
  const result = await runDast('positive_control');
  assert.equal(result.kind, 'positive_control');
  assert.equal(result.verdict, 'INDETERMINATE'); assert.equal(result.reason, 'high_finding');
  assert.equal(result.scan_complete, true); assert.equal(result.cleanup.complete, true);
  assert.equal(result.cleanup.resources.length, 2); assert(result.cleanup.resources.every(row => row.removed));
  assert.equal(result.nuclei.complete, true); assert.equal(result.nuclei.counts.high, 1); assert.equal(result.nuclei.counts.medium, 1);
  assert.equal(result.zap.complete, true); assert(result.zap.alerts['3'] >= 1); assert(result.zap.instances['3'] >= 1);
  // The report gate separately requires the exact two template IDs and ZAP10062.
  process.stdout.write(JSON.stringify({ schema_version: 1, run_id: result.run_id, accepted: true, reason: result.reason }) + '\n');
} catch {
  process.stdout.write('{"schema_version":1,"accepted":false,"reason":"positive_control"}\n'); process.exitCode = 1;
}
