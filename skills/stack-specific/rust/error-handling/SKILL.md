---
name: rust-error-handling
description: Rust error-handling patterns and anti-patterns -- `unwrap()` in request hot paths, `panic!` instead of returning a `Result`, leaking error internals via `Debug` derive on error types containing privileged state. Patterns covered include `thiserror` for typed errors, `anyhow` for application-layer error propagation, and error-payload sanitization at API boundaries. Triggers on Rust error-prone code authoring (`unwrap`, `expect`, `panic!`, `Result<_, _>` patterns). General security hygiene at the language-runtime layer.
---

# Rust Error Handling

> This skill addresses **general security hygiene at the
> language-runtime layer** -- the patterns close common Rust failure
> modes (request-handler panics, leaky error responses, internal-state
> exposure via `Debug`) but they are NOT the load-bearing defense
> against any specific OWASP ASI / AST threat. The agent-specific
> defenses operate at different layers: prompt-injection-defense for
> ASI01/ASI04, Tool Misuse defenses (e.g., webhook idempotency) for
> ASI02. Rust error handling is the substrate that lets the OTHER
> defenses work without panicking the whole process.

**Tradeoff:** `unwrap()` is shorter than proper `Result` handling.
Each `unwrap` in a request path is a future production panic. The
discipline below trades line-count for crash-resistance.

---

## Why this matters

A Rust web service that panics on `unwrap()` kills the request thread
(in `tokio` runtimes, the panic is caught by the task supervisor, but
the request returns 500 with no further detail). A panic that
propagates into the runtime's task scheduler can bring down the entire
process under load. The downstream effects are: lost requests, unclear
error attribution in logs, and -- if the panic's payload contains
privileged state (a database connection string, a JWT, a customer
email) -- accidental disclosure when the panic is logged.

The mitigation is structural: convert `unwrap()` / `panic!` paths to
`Result` returns that the caller can handle deliberately, derive
`Debug` carefully on error types that may carry sensitive payloads,
and sanitize the error response at the API boundary.

---

## Pattern 1 -- Typed errors with `thiserror`

Define one error enum per crate (or per logical module) using
`thiserror`. The enum variants name the failure modes the code can
encounter; their `Display` impls produce log-safe messages.

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CheckoutError {
    #[error("payment provider rejected the charge")]
    PaymentRejected,

    #[error("order {order_id} not found")]
    OrderNotFound { order_id: String },

    #[error("database error")]
    Database(#[from] sqlx::Error),

    #[error("internal: {0}")]
    Internal(String),
}
```

Each handler returns `Result<T, CheckoutError>` and uses `?` for
propagation. The caller (API handler, CLI command) maps the typed
error to an HTTP status / exit code in one place.

```rust
pub async fn checkout(order_id: String) -> Result<Receipt, CheckoutError> {
    let order = db::find_order(&order_id).await?;  // ? propagates Database errors
    let order = order.ok_or(CheckoutError::OrderNotFound { order_id })?;
    let receipt = payment::charge(&order).await
        .map_err(|_| CheckoutError::PaymentRejected)?;
    Ok(receipt)
}
```

This pattern keeps the happy path readable AND maintains structured
error categories for downstream handling.

---

## Pattern 2 -- `anyhow` for application-layer error propagation

For binary crates (CLIs, services) where typed errors would add ceremony
without value, use `anyhow::Result<T>`. It wraps any error type and
provides `.context(...)` for adding human-readable trace info.

```rust
use anyhow::{Context, Result};

pub async fn run(args: Args) -> Result<()> {
    let config = load_config(&args.config_path)
        .with_context(|| format!("failed to load config from {}", args.config_path))?;

    let pool = db::connect(&config.database_url).await
        .context("failed to connect to database")?;

    for migration in args.migrations {
        apply(&pool, migration).await
            .with_context(|| format!("migration {migration} failed"))?;
    }

    Ok(())
}
```

The `.context(...)` calls build a stack of trace messages. When an
error finally bubbles to `main()`, printing it produces a multi-line
trace that points at the operation, not just the leaf cause. This is
the closest Rust gets to Python tracebacks for application code.

`anyhow` is for application crates. Library crates should prefer
`thiserror` so consumers can pattern-match specific error variants.

---

## Pattern 3 -- Sanitize error payloads at the API boundary

Internal error types (typed with `thiserror`, traced with `anyhow`)
often contain implementation-specific detail: SQL state codes,
file system paths, third-party API responses. These should NOT
appear in HTTP responses to external clients.

```rust
use axum::response::{IntoResponse, Response};
use axum::http::StatusCode;

impl IntoResponse for CheckoutError {
    fn into_response(self) -> Response {
        // Log the FULL error for ourselves (server-side, audited).
        tracing::error!("checkout failed: {:?}", self);

        // Return a SANITIZED message to the client.
        let (status, message) = match self {
            CheckoutError::PaymentRejected => (StatusCode::PAYMENT_REQUIRED, "payment rejected"),
            CheckoutError::OrderNotFound { .. } => (StatusCode::NOT_FOUND, "order not found"),
            CheckoutError::Database(_) | CheckoutError::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
            },
        };
        (status, message).into_response()
    }
}
```

The server logs carry full detail for debugging; the client sees a
short message that doesn't leak the database schema, the payment
provider's specific error code, or any other internal state. This is
the load-bearing boundary control.

---

## Anti-patterns

### Anti-pattern 1 -- `unwrap()` in request hot paths

```rust
// WRONG
async fn get_user(Path(user_id): Path<String>) -> Json<User> {
    let user = db::find_user(&user_id).await.unwrap();  // PANIC on db error
    Json(user.unwrap())  // PANIC on user-not-found
}
```

Two panics per request, both triggered by ordinary conditions
(database down, user doesn't exist). The handler returns 500 with no
useful information, the panic message gets logged (potentially
revealing internal state), and under load these add up to a flaky
service. Convert to `Result` propagation; let the framework's error
handling produce sanitized responses.

`unwrap()` and `expect()` are acceptable in:
- Tests (panic = test fail, which is the intent)
- Constants / `const fn` contexts
- Genuinely unreachable cases where the panic would indicate a
  programming bug, not a runtime condition (annotate the rationale
  with a comment)

They are NOT acceptable in handler bodies, library APIs, or any path
that runs against attacker-controlled inputs.

### Anti-pattern 2 -- `panic!()` instead of returning a `Result`

```rust
// WRONG
fn parse_config(text: &str) -> Config {
    let parsed: Config = serde_json::from_str(text)
        .unwrap_or_else(|e| panic!("config parse failed: {}", e));
    parsed
}
```

The function signature lies: it claims to return `Config`, but really
returns `Config` OR panics. A caller that wraps it in error-handling
gets nothing because the panic skips over all error-handling layers.
Change the signature to `Result<Config, ConfigError>` and let the
caller decide how to react.

### Anti-pattern 3 -- Leaking internal state through `Debug` derive

```rust
// WRONG
#[derive(Debug)]
pub struct ApiError {
    pub status_code: u16,
    pub message: String,
    pub db_connection_string: String,  // leaks!
    pub jwt_signing_secret: String,    // leaks!
}
```

If `ApiError` is ever logged with `tracing::error!("{:?}", err)` or
serialized into a panic message, the privileged fields leak into log
storage. Either (a) don't store sensitive data on the error type --
they can stay in the production runtime's secrets store -- or (b)
manually implement `Debug` to redact:

```rust
impl std::fmt::Debug for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiError")
            .field("status_code", &self.status_code)
            .field("message", &self.message)
            .field("db_connection_string", &"[REDACTED]")
            .field("jwt_signing_secret", &"[REDACTED]")
            .finish()
    }
}
```

The same discipline applies to types embedded inside error variants
(a `sqlx::Error::Database` may carry the failed SQL statement, which
may itself contain user-controlled inputs that shouldn't be logged
verbatim).

---

## ASI/AST mapping

**No canonical ASI/AST applies** -- Rust error handling is general
security hygiene at the language-runtime layer; the failure modes
(panics, leaky errors, internal-state exposure) are not agent-specific
threat categories from `governance/owasp-asi-2026/threats.md`. Cross-
references to skills that DO address agent-specific surfaces:

- `skills/universal/security/prompt-injection-defense/SKILL.md` --
  ASI01 + ASI04 for content-level attacks
- `skills/universal/security/webhook-idempotency/SKILL.md` -- ASI02
  for control-flow replay attacks
- `skills/stack-specific/rust/cargo-audit/SKILL.md` -- AST08 for the
  dependency-update tampering surface (the supply-chain side of Rust)

The complementary `cargo-audit` skill covers the side of Rust hygiene
that DOES have a canonical AST mapping. Together the two Rust skills
span the language-substrate concerns for which agentic systems benefit
from explicit guidance.

---

## When this skill is working

- `grep -rn "unwrap()" src/` returns only test files (or annotated
  exceptions with rationale comments).
- Service `tracing::error!` logs never contain database connection
  strings, JWT secrets, or other secrets-class fields -- verified via
  log-redaction unit tests.
- Production 500-response messages are short, generic, and don't leak
  internal state -- verified via integration tests.

---

## See also

- The `thiserror` crate: https://docs.rs/thiserror/
- The `anyhow` crate: https://docs.rs/anyhow/
- `skills/stack-specific/rust/cargo-audit/SKILL.md` -- supply-chain
  companion (AST08)
