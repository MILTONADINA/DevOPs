# E2B Sandbox setup

On-demand cloud VMs for running untrusted code safely.

## Install

```bash
npm install @e2b/code-interpreter
```

## Configure

```bash
export E2B_API_KEY=...
```

## Use

```typescript
import { Sandbox } from '@e2b/code-interpreter';

const sandbox = await Sandbox.create();
const result = await sandbox.runCode(userCode);
await sandbox.kill();
```

The sandbox is isolated, has its own filesystem, and is destroyed after use.
No access to the host project or secrets.

## When to use

- User provides untrusted code
- Agent generates code that touches the network in unexpected ways
- RAG retrieves a code snippet that needs to be tested before integration
