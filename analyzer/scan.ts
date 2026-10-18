#!/usr/bin/env node
// analyzer/scan.ts
//
// Scans the current project and produces a structured profile.
// No installation. No side effects beyond writing the profile file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectState } from './project-state.js';
import { allDependencies } from './workspaces.js';

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
    next_steps: string[];
    initial_mode: string;
    initial_lifecycle: string;
  };
}

function fileExists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
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

    // specs/ops/analyzer-detection.md REQ-2: the root and every workspace package.
    const deps: Record<string, unknown> = allDependencies(root);
    const has = (name: string) => Object.hasOwn(deps, name);

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

  // specs/ops/analyzer-detection.md REQ-3: no manifest named a language, so read the sources.
  languageFromExtensions = false;
  if (stack.language.length === 0) {
    stack.language.push(...languagesFromExtensions(root));
    languageFromExtensions = stack.language.length > 0;
  }

  return stack;
}

let languageFromExtensions = false;

const EXTENSION_LANGUAGES: Record<string, string> = {
  '.ts': 'javascript/typescript', '.tsx': 'javascript/typescript', '.js': 'javascript/typescript',
  '.jsx': 'javascript/typescript', '.mjs': 'javascript/typescript', '.cjs': 'javascript/typescript',
  '.py': 'python', '.rs': 'rust', '.go': 'go',
};

// Bounded breadth-first walk: depth 4, 2000 entries; skips node_modules, hidden folders
// and symbolic links.
function languagesFromExtensions(root: string): string[] {
  const found = new Set<string>();
  let budget = 2000;
  let level = [root];
  for (let depth = 0; depth <= 4 && level.length > 0 && budget > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let handle: fs.Dir;
      try { handle = fs.opendirSync(dir); } catch { continue; }
      try {
        // Read one entry at a time so a huge directory is never enumerated past the budget.
        for (;;) {
          if (budget-- <= 0) return [...found];
          let entry: fs.Dirent | null;
          try { entry = handle.readSync(); } catch { break; }
          if (!entry) break;
          if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          if (entry.isDirectory()) next.push(path.join(dir, entry.name));
          else if (entry.isFile()) {
            const language = EXTENSION_LANGUAGES[path.extname(entry.name).toLowerCase()];
            if (language) found.add(language);
          }
        }
      } finally {
        try { handle.closeSync(); } catch { /* already closed */ }
      }
    }
    level = next;
  }
  return [...found];
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
    'process/proof-of-work',
    'process/baton-handoff',
    'process/spec-extraction',
    'process/plan-decomposition',
    'process/goal-loop',
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

  const mcp_servers = ['playwright'];
  const subagents = ['planner', 'coder', 'tester', 'reviewer', 'security', 'validator'];

  // Stack-specific additions
  // REQ-D4 (specs/phase-2/D-stack-specific-skills.md): on stack-indicator
  // detection, surface the corresponding stack-specific skills. The 9 skills
  // ship under skills/stack-specific/<stack>/<topic>/SKILL.md and are
  // authored / linted in session 4 (D.01-D.10). Inline conditional pattern
  // mirrors A.06 / H.03 / G.08.
  if (profile.stack.frameworks.includes('next.js')) {
    skills.push('development/openapi-first');
    skills.push('stack-specific/nextjs/server-action-safety');
    skills.push('stack-specific/nextjs/check-route-types');
  }
  if (profile.stack.frameworks.includes('stripe')) {
    skills.push('stack-specific/stripe/webhook-idempotency');
    skills.push('stack-specific/stripe/pci-scope-minimization');
  }
  if (profile.stack.frameworks.includes('fastapi')) {
    skills.push('stack-specific/fastapi/dependency-injection');
  }
  if (
    profile.stack.databases.includes('supabase (postgres)') ||
    profile.stack.auth.includes('supabase')
  ) {
    skills.push('stack-specific/supabase/rls-policies');
    skills.push('stack-specific/supabase/rpc-functions');
  }
  if (profile.stack.language.includes('rust')) {
    skills.push('stack-specific/rust/error-handling');
    skills.push('stack-specific/rust/cargo-audit');
  }
  if (profile.domain.compliance.includes('COPPA')) {
    skills.push('compliance/coppa-audit');
  }

  // REQ-A5 (specs/phase-2/A-pentest-stack.md): pentest-stack MCPs surface when the
  // project handles credentials or operates in a regulated scope. The 4 tools run
  // under the security subagent's scoped permissions; planner/coder must
  // not invoke them (enforced in subagents/universal/security.md).
  const triggersPentest =
    profile.domain.compliance.includes('PCI DSS') ||
    profile.domain.compliance.includes('HIPAA') ||
    profile.domain.compliance.includes('COPPA') ||
    profile.stack.auth.length > 0;
  if (triggersPentest) {
    mcp_servers.push('shannon', 'pentagi', 'lyrie', 'pentest-ai');
  }

  // REQ-G6 (specs/phase-2/G-webhook-idempotency.md): when the project has
  // webhook-handler indicators (route matching /webhook(s)?/, Stripe/GitHub
  // webhook headers, provider webhook SDK references), surface the universal
  // webhook-idempotency skill. The detection is a bounded heuristic on common
  // entry-point directories -- not a full source crawl. Downstream human
  // review of the recommendation is the final gate.
  if (detectWebhookIndicators(profile.project_root)) {
    skills.push('security/webhook-idempotency');
  }

  // REQ-H8 (specs/phase-2/H-renovate-template.md): when a consumer project
  // handles upgradable dependencies but has no upgrade-PR automation
  // configured, surface the Renovate template as a next-step recommendation.
  const next_steps: string[] = [];
  const root = profile.project_root;
  const hasUpgradableManifest =
    fileExists(path.join(root, 'package.json')) ||
    fileExists(path.join(root, 'requirements.txt')) ||
    fileExists(path.join(root, 'pyproject.toml')) ||
    fileExists(path.join(root, 'Cargo.toml')) ||
    fileExists(path.join(root, 'go.mod'));
  const hasRenovate = fileExists(path.join(root, 'renovate.json'));
  const hasDependabot =
    fileExists(path.join(root, '.github', 'dependabot.yml')) ||
    fileExists(path.join(root, '.github', 'dependabot.yaml'));
  if (hasUpgradableManifest && !hasRenovate && !hasDependabot) {
    next_steps.push('Use templates/renovate/renovate.json -- Renovate config for dependency-update PR automation (see docs/COST_OPTIMIZATION.md)');
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
    next_steps,
    initial_mode,
    initial_lifecycle,
  };
}

// REQ-G6 helper: detect webhook-handler indicators in the project root.
// Scans common entry-point directories one level deep (no recursive walk) for
// route paths or header references that signal a webhook receiver. Cheap
// heuristic; downstream human review of the recommendation is the final gate.
function detectWebhookIndicators(root: string): boolean {
  const webhookRoute = /['"\/]webhooks?[\/'"]/i;
  const stripeSig = /['"]Stripe-Signature['"]/;
  const githubSig = /['"]X-Hub-Signature(-256)?['"]/i;
  const sdkRef = /from\s+['"]@octokit\/webhooks['"]|require\s*\(\s*['"]@octokit\/webhooks['"]\s*\)|stripe\.webhooks\./;
  const hasIndicator = (file: string): boolean => {
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return false; }
    return webhookRoute.test(text) || stripeSig.test(text) || githubSig.test(text) || sdkRef.test(text);
  };

  // Same 2000-entry budget as languagesFromExtensions, shared by every listing below.
  // Entries are read one at a time, symbolic links are skipped, and the scan returns as
  // soon as one file shows an indicator.
  let budget = 2000;
  // Returns true when a file in `dir` has an indicator; sub-folders are handed to onDir.
  const scanDir = (dir: string, accept: (name: string) => boolean, onDir?: (full: string) => void): boolean => {
    let handle: fs.Dir;
    try { handle = fs.opendirSync(dir); } catch { return false; }
    try {
      for (;;) {
        if (budget-- <= 0) return false;
        let entry: fs.Dirent | null;
        try { entry = handle.readSync(); } catch { return false; }
        if (!entry) return false;
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile()) {
          if (accept(entry.name) && hasIndicator(path.join(dir, entry.name))) return true;
        } else if (entry.isDirectory() && onDir) onDir(path.join(dir, entry.name));
      }
    } finally {
      try { handle.closeSync(); } catch { /* already closed */ }
    }
  };

  for (const rel of ['src', 'app', 'pages', 'api', 'routes', 'server']) {
    if (budget <= 0) return false;
    const dir = path.join(root, rel);
    const subdirs: string[] = [];
    if (scanDir(dir, () => true, full => subdirs.push(full))) return true;
    for (const sub of subdirs) {
      if (budget <= 0) return false;
      if (scanDir(sub, () => true)) return true;
    }
  }
  return budget > 0 && scanDir(root, name => /\.(ts|tsx|js|jsx|py|rs|go)$/.test(name));
}


function main() {
  const root = process.cwd();
  console.log(`Analyzing ${root}...`);

  const stack = detectStack(root);
  // specs/ops/analyzer-detection.md REQ-1: git runs in root; a shallow clone is not new.
  const { state, note: stateNote } = detectState(root) as { state: Profile['state']; note: string | null };
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
  console.log(`State: ${state}${stateNote ? ` (${stateNote})` : ''}`);
  console.log(`Languages: ${stack.language.length === 0
    ? 'none detected (no manifest and no source files with known extensions). Run it from the project root or add package.json, pyproject.toml, Cargo.toml or go.mod.'
    : stack.language.join(', ') + (languageFromExtensions ? ' (from file extensions; no manifest found)' : '')}`);
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
