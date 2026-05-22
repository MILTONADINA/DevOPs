#!/usr/bin/env node
// scripts/devops-cli.js
//
// Main CLI dispatcher for `devops` command.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const DEVOPS_ROOT = process.env.DEVOPS_ROOT ?? path.join(process.env.HOME ?? '', 'DevOPs');
const [, , cmd, ...args] = process.argv;

const COMMANDS = {
  analyze: () => execFileSync(path.join(DEVOPS_ROOT, 'scripts/analyze.sh'), args, { stdio: 'inherit' }),
  init:    () => execFileSync(path.join(DEVOPS_ROOT, 'scripts/init-project.sh'), args, { stdio: 'inherit' }),
  verify:  () => execFileSync('tsx', [path.join(DEVOPS_ROOT, 'verification/claim-validator.ts'), ...args], { stdio: 'inherit' }),
  version: () => {
    const v = fs.readFileSync(path.join(DEVOPS_ROOT, 'package.json'), 'utf-8');
    console.log(JSON.parse(v).version);
  },
  help: () => {
    console.log(`devops — universal DevOps workflow for AI coding agents

Commands:
  devops analyze            Detect project stack, produce .workflow/profile.yml
  devops init               Install DevOPs into current project (after analyze)
  devops verify [options]   Run claim-validator
                            --all       validate all proofs
                            --no-rerun  schema + git checks only
  devops version            Print version
  devops help               This message

DevOPs root: ${DEVOPS_ROOT}
`);
  },
};

if (!cmd || cmd === '--help' || cmd === '-h') {
  COMMANDS.help();
} else if (COMMANDS[cmd]) {
  try {
    COMMANDS[cmd]();
  } catch (e) {
    process.exit((e && e.status) || 1);
  }
} else {
  console.error(`Unknown command: ${cmd}`);
  COMMANDS.help();
  process.exit(1);
}
