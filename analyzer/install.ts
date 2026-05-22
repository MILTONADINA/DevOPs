#!/usr/bin/env node
// analyzer/install.ts
//
// Reads .workflow/profile.yml and installs the recommended components
// into the project's .claude/ (or equivalent tool config dir).

import * as fs from 'node:fs';
import * as path from 'node:path';

const DEVOPS_ROOT = process.env.DEVOPS_ROOT ?? path.join(process.env.HOME ?? '', 'DevOPs');
const PROJECT_ROOT = process.cwd();

function copy(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copy(s, d);
  }
}

function loadProfileText(): string {
  const p = path.join(PROJECT_ROOT, '.workflow/profile.yml');
  if (!fs.existsSync(p)) {
    console.error('No .workflow/profile.yml found. Run ./scripts/analyze.sh first.');
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf-8');
}

function extractList(text: string, sectionKey: string): string[] {
  // Grab items under a `key:` heading until the next non-list line
  const lines = text.split('\n');
  const idx = lines.findIndex(l => l.trim() === `${sectionKey}:`);
  if (idx === -1) return [];
  const items: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    if (trimmed.startsWith('- ')) items.push(trimmed.slice(2).trim().replace(/^"|"$/g, ''));
    else if (trimmed === '') continue;
    else break;
  }
  return items;
}

function main() {
  const profile = loadProfileText();
  const skills = extractList(profile, 'skills');
  const hooks = extractList(profile, 'hooks');
  const subagents = extractList(profile, 'subagents');

  console.log(`Installing into ${PROJECT_ROOT}`);
  console.log(`DevOPs root: ${DEVOPS_ROOT}`);
  console.log('');

  // Install AGENTS.md template
  const targetAgents = path.join(PROJECT_ROOT, 'AGENTS.md');
  if (!fs.existsSync(targetAgents)) {
    copy(path.join(DEVOPS_ROOT, 'AGENTS.md'), targetAgents);
    console.log('✓ Installed AGENTS.md');
  } else {
    console.log('⚠ AGENTS.md already exists; not overwriting');
  }

  // Install CLAUDE.md adapter
  const targetClaude = path.join(PROJECT_ROOT, 'CLAUDE.md');
  if (!fs.existsSync(targetClaude)) {
    copy(path.join(DEVOPS_ROOT, 'CLAUDE.md'), targetClaude);
    console.log('✓ Installed CLAUDE.md');
  }

  // Install skills into .claude/skills/
  let skillsInstalled = 0;
  for (const s of skills) {
    const src = path.join(DEVOPS_ROOT, 'skills/universal', s);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(PROJECT_ROOT, '.claude/skills', path.basename(s));
    copyDir(src, dst);
    skillsInstalled++;
  }
  console.log(`✓ Installed ${skillsInstalled} skills`);

  // Install hooks into .claude/hooks/
  let hooksInstalled = 0;
  for (const h of hooks) {
    const src = path.join(DEVOPS_ROOT, 'hooks', h);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(PROJECT_ROOT, '.claude/hooks', path.basename(h));
    copy(src, dst);
    fs.chmodSync(dst, 0o755);
    hooksInstalled++;
  }
  console.log(`✓ Installed ${hooksInstalled} hooks`);

  // Install subagents
  let subagentsInstalled = 0;
  for (const a of subagents) {
    const src = path.join(DEVOPS_ROOT, `subagents/universal/${a}.md`);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(PROJECT_ROOT, '.claude/agents', `${a}.md`);
    copy(src, dst);
    subagentsInstalled++;
  }
  console.log(`✓ Installed ${subagentsInstalled} subagent definitions`);

  // Bootstrap .workflow/ state
  fs.mkdirSync(path.join(PROJECT_ROOT, '.workflow/state'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT_ROOT, '.workflow/proofs'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT_ROOT, '.workflow/memory'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT_ROOT, '.workflow/client'), { recursive: true });

  if (!fs.existsSync(path.join(PROJECT_ROOT, '.workflow/state/budget.yml'))) {
    copy(path.join(DEVOPS_ROOT, 'cost-controls/budget.yml'),
         path.join(PROJECT_ROOT, '.workflow/state/budget.yml'));
  }

  console.log('');
  console.log('Installation complete.');
  console.log('Next steps:');
  console.log('  1. Fill in .workflow/client/profile.yml with your client info');
  console.log('  2. Adjust .workflow/state/budget.yml for project budget');
  console.log('  3. Run /checkpoint at session end to write the baton');
}

main();
