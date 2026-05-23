---
name: fastapi-dependency-injection
description: FastAPI dependency-injection patterns and anti-patterns -- request-scoped auth tokens leaking into singleton DI graphs, missing `Depends()` declarations on auth-required routes, `dependency_overrides` mis-use in tests bleeding into production code paths. Triggers on FastAPI route authoring (`@app.get`, `@app.post`, `Depends()` references). OWASP ASI03 (Identity & Privilege Abuse) defense for auth-token handling via DI.
---

# FastAPI Dependency Injection

> Defends against **OWASP ASI03 (Identity & Privilege Abuse)** in
> FastAPI applications where the DI graph carries auth-relevant state.
> FastAPI's DI system is ergonomic for wiring shared dependencies
> (database sessions, settings, repositories), but its scoping model is
> per-request only by default -- and that semantic interacts subtly with
> auth-token handling. Without the patterns here, request-scoped
> identity can leak across requests via inadvertent caching, or
> auth-required routes can ship without an enforced auth check because
> the DI declaration was forgotten.

**Tradeoff:** Explicit `Depends()` declarations on every auth-required
route is repetitive vs. relying on global middleware. Worth it:
per-route auth dependencies are reviewable in isolation, can be
overridden in tests for the specific route, and produce typed access
to the authenticated identity inside the handler. Middleware-only auth
hides the contract from the handler signature.

---

## Why this matters

FastAPI's `Depends()` system resolves dependencies per request by
default -- new database session, fresh auth check, freshly-loaded
settings. But the framework also supports `lru_cache`-style memoization
for expensive dependencies (settings loading, model loading). If an
auth-related dependency is inadvertently memoized at the wrong scope,
the first request's identity propagates to all subsequent requests
hitting the same worker process. The error is silent: the test suite
passes (one request, one identity), production fails (many requests,
same memoized identity).

Separately, `dependency_overrides` -- FastAPI's testing affordance
that replaces a dependency for a test run -- is a global mutation on
the app's DI registry. A test that forgets to clean up its override
leaves the override in place for subsequent tests and (in pathological
cases where pytest-asyncio and prod share an app instance) for prod
traffic itself.

---

## Pattern 1 -- Declare auth as a `Depends` on every protected route, never via middleware-only

```python
from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

app = FastAPI()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

class User(BaseModel):
    id: str
    email: str

async def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    """Verify the token and return the authenticated user.

    Returns a fresh User instance per request -- the function body
    runs on each request, so no cross-request identity leakage.
    """
    user = await verify_token_against_session_store(token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired token",
        )
    return user

@app.get("/profile")
async def read_profile(current_user: User = Depends(get_current_user)) -> dict:
    # current_user is the per-request authenticated identity, typed
    # and visible in the handler signature -- a reviewer sees the auth
    # requirement directly without reading middleware config.
    return {"id": current_user.id, "email": current_user.email}
```

The auth requirement appears in the route signature. A new route that
omits `Depends(get_current_user)` is immediately reviewable as
unauthenticated -- there's no hidden middleware behavior masking the
absence.

For broad-application auth requirements (e.g., every route under
`/admin/**` requires admin role), use a `dependencies=` list on a
sub-router or `APIRouter` so the dependency is still visible at the
route-group level:

```python
from fastapi import APIRouter, Depends
from .auth import require_admin

admin_router = APIRouter(
    prefix="/admin",
    dependencies=[Depends(require_admin)],  # applies to every route under /admin
    tags=["admin"],
)
```

---

## Pattern 2 -- Scope expensive-to-construct dependencies correctly

```python
from functools import lru_cache
from fastapi import Depends
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    api_key: str
    class Config:
        env_file = ".env"

@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Settings are app-wide and immutable -- safe to memoize."""
    return Settings()

# In a route:
@app.get("/config")
async def read_config(settings: Settings = Depends(get_settings)) -> dict:
    return {"feature_flags": settings.feature_flags}
```

`@lru_cache` here is correct because Settings is read-only at process
startup. **Do NOT apply `@lru_cache` to functions that return
request-scoped state** (user identity, database sessions, request
context). The cache key is the function's arguments; if the function
has no arguments (like `get_settings()`), the result is process-global
and shared across every request.

The distinction is binary: process-scoped (settings, model objects,
http clients with their own pool) vs. request-scoped (auth identity,
db session, transaction). Mix them up and request-scoped state leaks
across requests.

---

## Pattern 3 -- Yield-pattern dependencies for resources needing cleanup

```python
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise

@app.post("/posts")
async def create_post(
    payload: PostCreateInput,
    db: AsyncSession = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
) -> Post:
    post = Post(author_id=current_user.id, **payload.model_dump())
    db.add(post)
    return post  # commit runs in the generator's finally-equivalent
```

`yield`-pattern dependencies guarantee setup-and-teardown semantics
per request. The transaction commits on success, rolls back on
exception, and the session is returned to the pool exactly once. This
is the closest FastAPI gets to a context manager at the route boundary.

---

## Anti-patterns

### Anti-pattern 1 -- Memoizing request-scoped state with `@lru_cache`

```python
# WRONG
@lru_cache(maxsize=1)
async def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    return await verify_token(token)
```

`@lru_cache` keys on the function args. The first request's token
becomes the cache key; every subsequent request with a different token
ALSO returns the first request's User because... actually `@lru_cache`
with maxsize=1 means each new token-arg evicts the cache, so the
caching is degenerate here. But the worse case: if the function has
NO args (e.g., a misguided refactor that reads token from a thread-local),
maxsize=1 caches the first identity forever. Test passes (one request);
prod corrupts identity. Never memoize auth dependencies.

### Anti-pattern 2 -- Middleware-only auth that's not visible in route signatures

```python
# WRONG
@app.middleware("http")
async def auth_middleware(request, call_next):
    if not request.headers.get("Authorization"):
        return Response(status_code=401)
    return await call_next(request)

@app.get("/internal-data")
async def read_internal():
    # No Depends(get_current_user). Reviewer can't tell from this
    # signature whether auth is enforced. If the middleware is later
    # made selective (e.g., only applies to /api/**), this route
    # silently becomes unauthenticated.
    return {"sensitive": "data"}
```

Middleware-only auth scales poorly: the auth contract isn't visible at
the route. A future change to the middleware (or a new route under a
different prefix) can silently turn off auth. Declare auth as a
`Depends` so the route's auth requirement is in the type signature.

### Anti-pattern 3 -- Leaving `dependency_overrides` in place across tests

```python
# WRONG
def test_admin_view():
    app.dependency_overrides[get_current_user] = lambda: User(id="admin")
    response = client.get("/admin/users")
    assert response.status_code == 200
    # No teardown -- the override persists for the next test, AND if
    # pytest-asyncio shares the app instance with prod (rare but real
    # in some monolith deployments), the override leaks into prod.
```

Use a fixture with proper teardown:

```python
import pytest
from fastapi.testclient import TestClient

@pytest.fixture
def admin_client():
    app.dependency_overrides[get_current_user] = lambda: User(id="admin", email="admin@example.test")
    client = TestClient(app)
    yield client
    app.dependency_overrides.clear()  # teardown
```

The fixture's teardown clears the overrides regardless of test outcome.
For larger test suites, prefer a per-test fixture instance of the app
rather than mutating a shared one.

---

## ASI/AST mapping

This skill addresses **canonical OWASP ASI03 (Identity & Privilege
Abuse)** from `governance/owasp-asi-2026/threats.md`. Auth-token
handling via DI is the load-bearing identity surface in a FastAPI
application; the three patterns above (per-route `Depends`, correct
scoping, yield-pattern cleanup) plus the three anti-patterns enumerate
the failure modes that lead to cross-request identity leakage or
silent auth bypass.

---

## Testing

For each protected route, write at least two tests:

```python
def test_route_requires_auth():
    response = client.get("/profile")
    assert response.status_code == 401

def test_route_returns_authenticated_user_data(admin_client):
    response = admin_client.get("/profile")
    assert response.status_code == 200
    assert response.json()["id"] == "admin"
```

Auth-required routes that don't have a `test_route_requires_auth`-style
test are a review smell: a future refactor that drops the `Depends`
on the route won't be caught until production traffic hits the
suddenly-unauthenticated endpoint.

---

## See also

- `governance/owasp-asi-2026/threats.md` -- ASI03 full text
- FastAPI docs: https://fastapi.tiangolo.com/tutorial/dependencies/
- FastAPI security:
  https://fastapi.tiangolo.com/tutorial/security/
