#!/usr/bin/env node
// Masterpiece REQ-M23: a new test file with no assertion never reads as PASS.
//
//   node scripts/check-assertions.mjs <file> [<file> ...]
//
// Exits 1 when any given test file contains no assert.*(...) / assert(...) / expect(...) call.
// CI passes the test files a pull request adds.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function hasAssertion(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return /\bassert(?:\.[A-Za-z]+)?\s*\(|\bexpect\s*\(/.test(code);
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const files = process.argv.slice(2);
  const empty = files.filter((f) => !hasAssertion(readFileSync(f, 'utf8')));
  for (const f of empty) console.error(`check-assertions: ${f} has no assert(...) or expect(...) call`);
  console.log(`check-assertions: ${files.length} file(s) checked, ${empty.length} without assertions`);
  process.exit(empty.length ? 1 : 0);
}
