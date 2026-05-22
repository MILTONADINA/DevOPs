#!/usr/bin/env node
// analyzer/scan.ts
//
// Scans the current project and produces a structured profile.
// No installation. No side effects beyond writing the profile file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

interface Profile {
  detected_at: string;
  project_root: string;
  stack: {
    language: string[];
    package_managers: string[];
    frameworks: string[];
    databases: string[];
    orms: string[];
    deploy_targets: string[];
    auth: string[];
  };
  domain: {
    classes: string[];
    compliance: string[];
  };
  state: 'greenfield' | 'brownfield' | 'migration' | 'hotfix' | 'audit';
  risk: {
    has_secrets_in_repo: boolean | null;
    has_open_vulns: boolean | null;
    recent_incident: boolean | null;
  };
  recommended: {
    skills: string[];
    hooks: string[];
    mcp_servers: string[];
    subagents: string[];
    initial_mode: string;
    initial_lifecycle: string;
  };
}

function fileExists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

function readJson(p: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}

function detectStack(root: string): Profile['stack'] {
  const stack: Profile['stack'] = {
    language: [],
    package_managers: [],
    frameworks: [],
    databases: [],
    orms: [],
    deploy_targets: [],
    auth: [],
  };

  // Languages and package managers
  if (fileExists(path.join(root, 'package.json'))) {
    stack.language.push('javascript/typescript');
    if (fileExists(path.join(root, 'pnpm-lock.yaml'))) stack.package_managers.push('pnpm');
    else if (fileExists(path.join(root, 'yarn.lock'))) stack.package_managers.push('yarn');
    else if (fileExists(path.join(root, 'package-lock.json'))) stack.package_managers.push('npm');
    else if (fileExists(path.join(root, 'bun.lockb'))) stack.package_managers.push('bun');

    const pkg = readJson(path.join(root, 'package.json'));
    const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) };
    const has = (name: string) => name in deps;

    if (has('next')) stack.frameworks.push('next.js');
    if (has('@remix-run/react')) stack.frameworks.push('remix');
    if (has('astro')) stack.frameworks.push('astro');
    if (has('hono')) stack.frameworks.push('hono');
    if (has('express')) stack.frameworks.push('express');
    if (has('fastify')) stack.frameworks.push('fastify');
    if (has('@nestjs/core')) stack.frameworks.push('nestjs');
    if (has('vite')) stack.frameworks.push('vite');
    if (has('react')) stack.frameworks.push('react');
    if (has('vue')) stack.frameworks.push('vue');
    if (has('svelte')) stack.frameworks.push('svelte');

    if (has('@prisma/client')) stack.orms.push('prisma');
    if (has('drizzle-orm')) stack.orms.push('drizzle');
    if (has('kysely')) stack.orms.push('kysely');

    if (has('@supabase/supabase-js')) { stack.databases.push('supabase (postgres)'); stack.auth.push('supabase'); }
    if (has('mysql2') || has('mysql')) stack.databases.push('mysql');
    if (has('pg') || has('postgres')) stack.databases.push('postgres');
    if (has('mongodb') || has('mongoose')) stack.databases.push('mongodb');
    if (has('redis') || has('ioredis')) stack.databases.push('redis');

    if (has('@auth/core') || has('next-auth')) stack.auth.push('next-auth');
    if (has('@clerk/nextjs')) stack.auth.push('clerk');

    if (has('stripe')) stack.frameworks.push('stripe');
  }

  if (fileExists(path.join(root, 'pyproject.toml'))) {
    stack.language.push('python');
    stack.package_managers.push('pip/poetry/uv');
    const content = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf-8');
    if (content.includes('fastapi')) stack.frameworks.push('fastapi');
    if (content.includes('django')) stack.frameworks.push('django');
    if (content.includes('flask')) stack.frameworks.push('flask');
    if (content.includes('sqlalchemy')) stack.orms.push('sqlalchemy');
  }

  if (fileExists(path.join(root, 'Cargo.toml'))) {
    stack.language.push('rust');
    stack.package_managers.push('cargo');
    const content = fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf-8');
    if (content.includes('axum')) stack.frameworks.push('axum');
    if (content.includes('actix-web')) stack.frameworks.push('actix-web');
    if (content.includes('sqlx')) stack.orms.push('sqlx');
    if (content.includes('diesel')) stack.orms.push('diesel');
  }

  if (fileExists(path.join(root, 'go.mod'))) {
    stack.language.push('go');
    stack.package_managers.push('go modules');
  }

  // Deploy targets
  if (fileExists(path.join(root, 'vercel.json')) || fileExists(path.join(root, '.vercel'))) stack.deploy_targets.push('vercel');
  if (fileExists(path.join(root, 'netlify.toml'))) stack.deploy_targets.push('netlify');
  if (fileExists(path.join(root, 'fly.toml'))) stack.deploy_targets.push('fly');
  if (fileExists(path.join(root, 'railway.toml')) || fileExists(path.join(root, '.railway'))) stack.deploy_targets.push('railway');
  if (fileExists(path.join(root, 'render.yaml'))) stack.deploy_targets.push('render');
  if (fileExists(path.join(root, 'wrangler.toml'))) stack.deploy_targets.push('cloudflare-workers');
  if (fileExists(path.join(root, 'Dockerfile'))) stack.deploy_targets.push('docker');

  return stack;
}

function detectState(root: string): Profile['state'] {
  if (!fileExists(path.join(root, '.git'))) return 'greenfield';
  try {
    const commitCount = parseInt(
      execSync('git rev-list --count HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(),
      10,
    );
    if (commitCount < 5) return 'greenfield';
  } catch { /* ignore */ }

  // Check for recent incident markers
  if (fileExists(path.join(root, 'docs/incidents'))) {
    const dir = path.join(root, 'docs/incidents');
    const recent = fs.readdirSync(dir).filter(f => f.startsWith(new Date().getFullYear().toString())).length > 0;
    if (recent) return 'hotfix';
  }

  return 'brownfield';
}

function detectDomain(stack: Profile['stack']): Profile['domain'] {
  const classes: string[] = [];
  const compliance: string[] = [];

  if (stack.frameworks.includes('stripe')) {
    classes.push('financial', 'PCI');
    compliance.push('PCI DSS');
  }
  if (stack.auth.length > 0) {
    classes.push('PII');
    compliance.push('GDPR');
  }

  // Heuristic: look for keywords in README
  try {
    const readme = fs.readFileSync('README.md', 'utf-8').toLowerCase();
    if (/child|kid|minor|under.?13|coppa|k-12|education/.test(readme)) {
      classes.push("children's data");
      compliance.push('COPPA');
    }
    if (/patient|hipaa|phi|health record/.test(readme)) {
      classes.push('PHI');
      compliance.push('HIPAA');
    }
  } catch { /* ignore */ }

  return { classes, compliance };
}

function recommend(profile: Omit<Profile, 'recommended'>): Profile['recommended'] {
  const skills: string[] = [
    'process/karpathy-guidelines',
    'process/proof-of-work',
    'process/baton-handoff',
    'process/ask-dont-assume',
    'process/spec-extraction',
    'process/plan-decomposition',
    'process/goal-loop',
    'process/surgical-edits',
    'process/session-summary',
    'process/multi-tool-failover',
    'development/ears-spec-writing',
    'security/owasp-asi-threat-model',
    'security/prompt-injection-defense',
    'security/gitleaks-scan',
    'security/semgrep-scan',
    'devops/observability-instrument',
    'devops/cost-attribution',
  ];

  const hooks: string[] = [
    'universal/pre-tool/block-secrets.sh',
    'universal/pre-tool/block-prod-write.sh',
    'universal/pre-tool/block-rm-rf.sh',
    'universal/pre-tool/budget-brake.sh',
    'universal/pre-tool/loop-detection.sh',
    'universal/pre-tool/client-boundary.sh',
    'universal/post-tool/auto-format.sh',
    'universal/post-tool/gitleaks-scan.sh',
    'universal/session-start/load-baton.sh',
    'universal/session-end/write-baton.sh',
  ];

  const mcp_servers = ['playwright', 'zep-memory'];
  const subagents = ['planner', 'researcher', 'coder', 'tester', 'reviewer', 'security', 'validator'];

  // Stack-specific additions
  if (profile.stack.frameworks.includes('next.js')) {
    skills.push('development/openapi-first');
    hooks.push('stack-specific/nextjs/check-route-types.sh');
  }
  if (profile.stack.frameworks.includes('stripe')) {
    skills.push('stack-specific/stripe/webhook-idempotency');
    skills.push('stack-specific/stripe/pci-scope');
  }
  if (profile.domain.compliance.includes('COPPA')) {
    skills.push('compliance/coppa-audit');
  }

  let initial_mode = 'brownfield';
  if (profile.state === 'greenfield') initial_mode = 'greenfield';
  if (profile.state === 'hotfix') initial_mode = 'hotfix';

  let initial_lifecycle = 'build';
  if (profile.state === 'greenfield') initial_lifecycle = 'discovery';

  return {
    skills: [...new Set(skills)],
    hooks: [...new Set(hooks)],
    mcp_servers,
    subagents,
    initial_mode,
    initial_lifecycle,
  };
}

function main() {
  const root = process.cwd();
  console.log(`Analyzing ${root}...`);

  const stack = detectStack(root);
  const state = detectState(root);
  const domain = detectDomain(stack);

  const partial: Omit<Profile, 'recommended'> = {
    detected_at: new Date().toISOString(),
    project_root: root,
    stack,
    domain,
    state,
    risk: {
      has_secrets_in_repo: null,    // run gitleaks-scan separately to populate
      has_open_vulns: null,         // run pnpm audit / safety / cargo audit
      recent_incident: state === 'hotfix',
    },
  };

  const profile: Profile = { ...partial, recommended: recommend(partial) };

  fs.mkdirSync('.workflow', { recursive: true });
  fs.writeFileSync('.workflow/profile.yml', toYaml(profile));
  console.log('Wrote .workflow/profile.yml');
  console.log(`State: ${state}`);
  console.log(`Languages: ${stack.language.join(', ') || '(none detected)'}`);
  console.log(`Frameworks: ${stack.frameworks.join(', ') || '(none detected)'}`);
  console.log(`Compliance scope: ${domain.compliance.join(', ') || '(none detected)'}`);
  console.log(`Recommended skills: ${profile.recommended.skills.length}`);
}

function toYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return '\n' + obj.map(v => `${pad}- ${toYaml(v, indent + 1).trimStart()}`).join('\n');
  }
  if (typeof obj === 'object') {
    return '\n' + Object.entries(obj).map(([k, v]) =>
      `${pad}${k}: ${typeof v === 'object' && v !== null ? toYaml(v, indent + 1) : toYaml(v, indent + 1)}`
    ).join('\n');
  }
  return String(obj);
}

main();
