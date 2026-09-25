# Runbooks

Operator runbooks for this repository. They describe what the code does today
on a development machine. The hosted Supabase project is retired; every
database procedure here targets the project-local Compose stack
(`stratum/docs/decisions/0020-local-storage-after-hosted-retirement.md`). No
runbook here describes a production deployment, because none is documented as
live (`CLAUDE.md:167-172`).

These files are the `plan.md` §7b "Runbooks" item (`plan.md:407`).

| Runbook | Use it when |
| --- | --- |
| [LOCAL_STRATUM.md](LOCAL_STRATUM.md) | Starting and checking the local stack, reviewing a decision replacement, the step-by-step organization backup and restore, and database-level triage. |
| [BACKUP_RESTORE.md](BACKUP_RESTORE.md) | Deciding what a backup covers, verifying a backup file, understanding the restore write path and the disposable recovery check, and the known limits. |
| [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) | Something is wrong: proxy health, logs, the graph kill switch, a blocked graph cycle, a leaked key, or a proxy that is down. |
| [COMMON_TASKS.md](COMMON_TASKS.md) | Setup and teardown, tests and eval gates, minting and revoking API keys, and applying migrations. |

## Conventions

- Stratum commands run from `stratum/`. The local stack wrapper refuses any
  other working directory (`stratum/scripts/local-compose.ts:166`).
- Commands that need the database go through `npm run db:with-env -- ...`.
  The wrapper supplies `SUPABASE_URL` and a short-lived service JWT to that
  one child process (`stratum/scripts/local-compose.ts:157-163`). Never copy
  that JWT into a file.
- Exit code 0 is not always success. Several operator CLIs print `SKIPPED` and
  exit 0 when database settings are missing. Each runbook names the output line
  to require.
- Citations use `path:line`, relative to the repository root.
