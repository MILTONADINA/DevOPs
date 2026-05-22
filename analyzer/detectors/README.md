# Detectors

Modular detection units. Each detector implements one concern (language,
framework, compliance scope, etc.) and returns a structured result.

Detectors are pure: read-only against the filesystem, no network, no
modifications. The orchestrator (`scan.ts`) calls them and merges results.

Add new detectors here. Each should:
- Be a single .ts file
- Export a `detect(root: string): Promise<DetectionResult>` function
- Document what it looks for

Current detectors live inline in `scan.ts`. Move them here when they grow
beyond ~30 lines each.
