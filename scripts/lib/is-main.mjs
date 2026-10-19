import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// True when the module at importMetaUrl is the entry script. Compares real
// paths because Node resolves symlinks in the main module's path.
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(process.argv[1]); }
  catch { return false; }
}
