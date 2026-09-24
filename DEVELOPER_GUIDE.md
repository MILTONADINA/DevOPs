# Developer guide

This guide is for contributors working in a local DevOPs checkout. Read
[`AGENTS.md`](AGENTS.md) and the [contributor rules](CONTRIBUTING.md) before
changing code. Every nontrivial change needs a section in `specs/` and proof
of the behavior it changes.

## Start a local checkout

Use macOS, Linux, or WSL2 with Node 20.11 or newer, npm, Docker Engine, and
Docker Compose. Start Docker before setup. Native Windows is unsupported.

```sh
git clone https://github.com/MILTONADINA/DevOPs.git
cd DevOPs
npm run setup
```

The root command installs missing Stratum dependencies, starts the project
Compose stack on `127.0.0.1:54321`, applies migrations, and checks a real
proxy listener and local database. It does not leave the proxy running or
configure an LLM provider. Set a provider in your process environment or
secret manager, then start the proxy:

```sh
cd stratum
npm run db:with-env -- npm run dev
```

For an independent checkout on the same host, set both
`DEVOPS_LOCAL_INSTANCE` (lowercase letters, digits, and hyphens, up to 20
characters) and `DEVOPS_LOCAL_PORT` (an unused port from 1024 to 65535)
before setup. Do not use port 54321. Use those same values for later
`db:with-env` and `db:stop` commands in that checkout. See
[local storage](stratum/docs/LOCAL_STORAGE.md) for the isolated-stack example.

See the [local operations runbook](docs/runbooks/LOCAL_STRATUM.md) for stop,
migration, disposable verification, backup, and clean-target restore. Setup
passing on one host does not prove clean macOS/WSL2 installation,
provider-backed traffic, or recovery of real data.

## Verify your change

Run the smallest relevant check first. These commands match the current
package manifests:

| Scope | Command | Use |
| --- | --- | --- |
| Root | `npm test` | Root CLI, workflow, and dashboard tests |
| Stratum | `cd stratum && npm test` | Stratum Vitest suite |
| Stratum | `cd stratum && npm run typecheck` | TypeScript types |
| Stratum | `cd stratum && npm run lint` | ESLint and Prettier checks |
| Proof | `npm run validate:claims -- path/to/claim.yml --no-rerun` | Validate a new claim's schema and Git provenance |

Keep proof output under the ignored `.workflow/proofs/` directory. Use the
claim schema in [verification/claim-schema.yml](verification/claim-schema.yml)
and the [verification guide](docs/VERIFICATION.md). Run a full claim rerun
only when its command and prerequisites apply to this checkout; some older
claims refer to external systems or an earlier environment.

## Open and review a pull request

1. Link the relevant `specs/` section in the change and PR description.
   Make a focused commit and include the test command, result, and any
   limitation in the PR.
2. Review the diff for correctness and security. Claude Code contributors
   can use `/code-review` and `/security-review` before pushing. Other tools
   can perform the same review against the changed files.
3. Check the PR's `validate`, `setup-linux`, `gitleaks`, `semgrep`, and
   `deepteam` jobs. The Claude semantic security job reports a skip when
   `CLAUDE_API_KEY` is unset; a green skipped job is not an AI review.
4. Address review findings, verify the checks on the final head commit, and
   merge through the protected PR flow. See the full
   [contributor checklist](CONTRIBUTING.md#per-pr-review-checklist-author--reviewer).

Release tags are owner-signed. Follow the [signing procedure](PERSONAL_USE.md)
and [release spec](specs/release/v0.3.0.md) when preparing a release. Keep
private keys, passphrases, provider credentials, and organization backups out
of commits, PR bodies, and logs.
