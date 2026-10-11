#!/usr/bin/env node
// scripts/devops-cli.js
//
// Main CLI dispatcher for `devops` command.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { devopsRoot, runTs, tsxCli } from './devops-paths.js';

// specs/release/npm-package.md REQ-2: the installed package, not a fixed home folder.
const DEVOPS_ROOT = devopsRoot();
const [, , cmd, ...args] = process.argv;

// `devops init` is a shell script; it runs the installer with this Node and the
// package's own tsx, so it needs neither on PATH (REQ-3).
function initCommand() {
  const result = spawnSync('bash', [path.join(DEVOPS_ROOT, 'scripts/init-project.sh'), ...args], {
    stdio: 'inherit',
    env: { ...process.env, DEVOPS_ROOT, DEVOPS_NODE: process.execPath, DEVOPS_TSX: tsxCli() },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Phase 2 Area C / REQ-C6 — `devops approve <claim-id> --rationale="..."` writes
// a structured JSONL line to .workflow/state/approvals.jsonl. Each entry carries
// approval_token + entry_hmac. Manual edits to the file are NOT recognised by
// the pre-tool gate (C.08) because entry_hmac is keyed with the session-key.
function approveCommand(approveArgs) {
  const claimId = approveArgs[0];
  const rationaleArg = approveArgs.find(a => a.startsWith('--rationale='));
  if (!claimId || claimId.startsWith('--')) {
    console.error('Usage: devops approve <claim-id> --rationale="<non-empty>"');
    process.exit(1);
  }
  if (!rationaleArg) {
    console.error('Missing --rationale=. AC-C6.1: rationale is mandatory.');
    process.exit(1);
  }
  const rationale = rationaleArg.slice('--rationale='.length).replace(/^"|"$/g, '');
  if (rationale.trim().length === 0) {
    console.error('Empty rationale rejected. AC-C6.1 requires non-empty rationale.');
    process.exit(1);
  }
  const sessionKeyPath = path.join('.workflow', 'state', 'session-key');
  if (!fs.existsSync(sessionKeyPath)) {
    console.error('No session-key at .workflow/state/session-key. Run the boundary layer or `devops verify` first to initialise.');
    process.exit(1);
  }
  const sessionKey = Buffer.from(fs.readFileSync(sessionKeyPath, 'utf-8').trim(), 'hex');
  let approver = 'unknown';
  try {
    approver = execFileSync('git', ['config', 'user.email'], { encoding: 'utf-8' }).trim() || approver;
  } catch { /* not in a git repo or no user.email set; keep "unknown" */ }
  const approvalToken = randomBytes(16).toString('hex');
  const macInput = approver + claimId + approvalToken;
  const entryHmac = createHmac('sha256', sessionKey).update(macInput).digest('base64');
  const entry = {
    timestamp: new Date().toISOString(),
    claim_id: claimId,
    rationale,
    approver_identity: approver,
    approval_token: approvalToken,
    entry_hmac: entryHmac,
  };
  const approvalsPath = path.join('.workflow', 'state', 'approvals.jsonl');
  fs.mkdirSync(path.dirname(approvalsPath), { recursive: true });
  fs.appendFileSync(approvalsPath, JSON.stringify(entry) + '\n');
  console.log(`approval logged: claim_id=${claimId} approval_token=${approvalToken} (one-shot; consume by destructive tool call)`);
}

// Each command returns an exit status, or undefined for success.
const COMMANDS = {
  analyze: () => runTs(path.join(DEVOPS_ROOT, 'analyzer/scan.ts'), args),
  init:    () => initCommand(),
  verify:  () => runTs(path.join(DEVOPS_ROOT, 'verification/claim-validator.ts'), args),
  approve: () => approveCommand(args),
  version: () => {
    const v = fs.readFileSync(path.join(DEVOPS_ROOT, 'package.json'), 'utf-8');
    console.log(JSON.parse(v).version);
  },
  help: () => {
    console.log(`devops — universal DevOps workflow for AI coding agents

Commands:
  devops analyze            Detect project stack, produce .workflow/profile.yml
  devops init               Install DevOPs into current project (after analyze)
  devops verify [options]   Validate declared claim metadata
                            --all --no-rerun       committed nonempty set
                            --claim ID --no-rerun  one committed ID; bind all members
                            FILE --no-rerun        local compatibility checks
                            Committed selectors require a published manifest.
                            Metadata acceptance does not prove command execution.
                            --no-rerun is required; command replay is disabled.
  devops approve <claim-id> --rationale="..."
                            Log a one-shot approval token (REQ-C6) to
                            .workflow/state/approvals.jsonl. Consumed
                            by the next destructive tool call after a
                            prompt-injection block.
  devops version            Print version
  devops help               This message

DevOPs root: ${DEVOPS_ROOT}
`);
  },
};

if (!cmd || cmd === '--help' || cmd === '-h') {
  COMMANDS.help();
} else if (Object.hasOwn(COMMANDS, cmd)) {
  let status;
  try {
    status = COMMANDS[cmd]();
  } catch (e) {
    process.exit((e && e.status) || 1);
  }
  if (typeof status === 'number' && status !== 0) process.exit(status);
} else {
  console.error(`Unknown command: ${cmd}`);
  COMMANDS.help();
  process.exit(1);
}
