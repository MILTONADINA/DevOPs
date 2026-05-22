# Sandbox

Isolated execution environments for the agent. Three options depending on
context.

## Options

### devcontainer (recommended for local dev)
Full project devcontainer with pinned tooling. Reproducible across machines.
Strongly recommended; many production agent disasters trace to "it worked
on my laptop."

### E2B (for cloud sandboxes)
On-demand cloud VMs for running untrusted code. Used when the agent needs to
run arbitrary user code that we can't trust to be safe.

### Docker (for CI / fallback)
Dockerfile.dev with the same toolchain as the devcontainer. CI uses this.

## When to require sandboxing

- Running untrusted code (user uploads, RAG-discovered code)
- Pentest / red-team exercises
- Migration replays (run the old and new in parallel)
- Disposable experiments
