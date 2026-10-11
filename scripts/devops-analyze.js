#!/usr/bin/env node
// scripts/devops-analyze.js
//
// The `devops-analyze` command: the same as `devops analyze`. It scans the current
// directory and writes .workflow/profile.yml (specs/release/npm-package.md REQ-2).

import * as path from 'node:path';
import { devopsRoot, runTs } from './devops-paths.js';

process.exitCode = runTs(path.join(devopsRoot(), 'analyzer/scan.ts'), process.argv.slice(2));
