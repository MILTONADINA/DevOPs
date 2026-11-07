// specs/release/npm-package.md REQ-15 (#353): scripts/init-project.sh calls this
// around its write of the DevOPs pre-commit hook, which lives in Git's hooks
// folder (possibly outside the project), so the install manifest records it.
//   record-hook.mjs <project> <hook file> before|after
import { HOOK_KEY, openManifest } from './install-manifest.js';

const [root, hook, step] = process.argv.slice(2);
if (!root || !hook || !['before', 'after'].includes(step)) {
  console.error('usage: record-hook.mjs <project> <hook file> before|after');
  process.exit(1);
}
try {
  const record = openManifest(root);
  record[step](HOOK_KEY, hook);
  // The before step keeps its pending entry: the after step runs in a new process.
  record.save({ keepPending: step === 'before' });
} catch (error) {
  console.error(`devops: could not record the pre-commit hook: ${error.message}`);
  process.exit(2);
}
