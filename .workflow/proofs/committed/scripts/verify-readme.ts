// specs/verification/committed-claims.md REQ-8: named documentation content only.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitContext } from '../../../../verification/committed-git.ts';
import { readInputBytes, decodeInput } from '../../../../verification/claim-input.ts';

const TARGET = 'daa1250309c770f322d73d872af3d83b42bd7d24';
const README = 'verification/README.md';
const CHECKS = '.workflow/proofs/committed/_checks/readme-disclosure.json';
const CAP = 262144;
const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function assertReadmeDisclosure(text: string, requiredPhrases: unknown): void {
  if (typeof text !== 'string' || !Array.isArray(requiredPhrases) || requiredPhrases.length !== 3 ||
      requiredPhrases.some(phrase => typeof phrase !== 'string' || normalize(phrase) === '')) {
    throw new Error('README disclosure assertion failed');
  }
  const phrases = requiredPhrases.map(phrase => normalize(phrase));
  const content = normalize(text);
  if (new Set(phrases).size !== 3 || phrases.some(phrase => !content.includes(phrase))) {
    throw new Error('README disclosure assertion failed');
  }
}

function main(): void {
  try {
    if (process.argv.length !== 2) throw new Error();
    const root = fs.realpathSync(process.cwd());
    const checks = JSON.parse(decodeInput(readInputBytes(CHECKS, root, 'member', CAP), 'member'));
    if (!checks || typeof checks !== 'object' || Array.isArray(checks) ||
        Object.keys(checks).sort().join(',') !== 'required_phrases,schema_version,target_git_sha,target_path' ||
        checks.schema_version !== 1 || checks.target_git_sha !== TARGET || checks.target_path !== README) throw new Error();
    const git = createGitContext(root);
    const text = decodeInput(git.readRegularBlob(TARGET, README, CAP), 'member');
    assertReadmeDisclosure(text, checks.required_phrases);
    console.log(`README disclosure proof passed: target=${TARGET} path=${README} required_phrases=3`);
  } catch {
    console.error('README disclosure proof failed');
    process.exitCode = 1;
  }
}

// Importing the pure assertion for an owned negative control must not launch main.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
