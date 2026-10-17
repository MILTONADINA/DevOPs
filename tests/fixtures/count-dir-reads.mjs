// Preload for tests/init-dry-run-and-language-fallback.test.mjs (issue #271): counts
// fs.Dir opens, reads and closes under DIR_COUNT_ROOT and writes the totals to
// DIR_COUNT_OUT.<pid> when the process exits. With DIR_COUNT_THROW=1 the first read
// of each directory throws, to prove the walk still closes it.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const root = process.env.DIR_COUNT_ROOT;
const out = process.env.DIR_COUNT_OUT;
if (root && out) {
  const counts = { opened: 0, reads: 0, closed: 0 };
  const failed = new WeakSet();
  const inside = dir => dir.path === root || dir.path.startsWith(root + '/');
  const { opendirSync } = fs;
  fs.opendirSync = function (...args) {
    const dir = opendirSync.apply(this, args);
    if (inside(dir)) counts.opened++;
    return dir;
  };
  const { readSync, closeSync } = fs.Dir.prototype;
  fs.Dir.prototype.readSync = function (...args) {
    if (inside(this)) {
      counts.reads++;
      if (process.env.DIR_COUNT_THROW === '1' && !failed.has(this)) {
        failed.add(this);
        throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      }
    }
    return readSync.apply(this, args);
  };
  fs.Dir.prototype.closeSync = function (...args) {
    if (inside(this)) counts.closed++;
    return closeSync.apply(this, args);
  };
  // Named imports of node:fs see the wrapped opendirSync too.
  syncBuiltinESMExports();
  process.on('exit', () => fs.writeFileSync(`${out}.${process.pid}`, JSON.stringify(counts)));
}
