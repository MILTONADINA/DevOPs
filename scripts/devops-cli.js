#!/usr/bin/env node
// scripts/devops-cli.js
//
// Main CLI dispatcher for `devops` command.

import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

const DEVOPS_ROOT = process.env.DEVOPS_ROOT ?? path.join(process.env.HOME ?? '', 'DevOPs');
const [, , cmd, ...args] = process.argv;

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

const COMMANDS = {
  analyze: () => execFileSync(path.join(DEVOPS_ROOT, 'scripts/analyze.sh'), args, { stdio: 'inherit' }),
  init:    () => execFileSync(path.join(DEVOPS_ROOT, 'scripts/init-project.sh'), args, { stdio: 'inherit' }),
  verify:  () => execFileSync('tsx', [path.join(DEVOPS_ROOT, 'verification/claim-validator.ts'), ...args], { stdio: 'inherit' }),
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
  devops verify [options]   Run claim-validator
                            --all       validate all proofs
                            --no-rerun  schema + git checks only
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
