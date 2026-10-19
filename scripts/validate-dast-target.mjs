#!/usr/bin/env node
// specs/security/local-dast.md REQ-2: admission never starts a workload.
import { isMain } from './lib/is-main.mjs';

export function validTarget(value) {
  return value === 'http://127.0.0.1:18080/docs';
}

if (isMain(import.meta.url)) {
  const accepted = process.argv.length === 2 && validTarget(process.env.DAST_TARGET);
  (accepted ? process.stdout : process.stderr).write(`dast-target: ${accepted ? 'accepted' : 'refused'}\n`);
  process.exitCode = accepted ? 0 : 1;
}
