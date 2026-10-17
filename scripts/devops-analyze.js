#!/usr/bin/env node
// scripts/devops-analyze.js
//
// The `devops-analyze` command: the same as `devops analyze`. It scans the current
// directory and writes .workflow/profile.yml (specs/release/npm-package.md REQ-2).
// Flags are answered before any scan, so `--help` never writes files (REQ-9).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { devopsRoot, runTs } from './devops-paths.js';

const args = process.argv.slice(2);
const flag = args.find((a) => a.startsWith('-'));

if (flag === '--help' || flag === '-h') {
  console.log(`Usage: devops-analyze

Detect the project stack in the current directory and write .workflow/profile.yml.

Options:
  -h, --help       Print this usage and exit
  -v, --version    Print the package version and exit`);
} else if (flag === '--version' || flag === '-v') {
  console.log(JSON.parse(fs.readFileSync(path.join(devopsRoot(), 'package.json'), 'utf8')).version);
} else if (flag) {
  console.error(`devops-analyze: unknown option '${flag}'. Run 'devops-analyze --help' for usage.`);
  process.exitCode = 2;
} else {
  process.exitCode = runTs(path.join(devopsRoot(), 'analyzer/scan.ts'), args);
}
