---
name: rust-error-handling
description: Rust error-handling patterns and anti-patterns -- `unwrap()` in request hot paths, `panic!` instead of returning a `Result`, leaking error internals via `Debug` derive on error types containing privileged state. Patterns covered include `thiserror` for typed errors, `anyhow` for application-layer error propagation, and error-payload sanitization at API boundaries. Triggers on Rust error-prone code authoring (`unwrap`, `expect`, `panic!`, `Result<_, _>` patterns). General security hygiene at the language-runtime layer.
---

# Rust Error Handling

> Phase 2 Step 4 scaffold. Skill body is authored in session 4 batch 3.
> See `specs/phase-2/D-stack-specific-skills.md` REQ-D1 through REQ-D7 for
> the requirement bar this skill satisfies.
