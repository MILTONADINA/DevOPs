# Security Policy

## Supported versions

DevOPs is pre-1.0. Only the latest 0.x minor line receives security fixes.
Older minors are not patched; upgrade to the latest minor.

| Version                 | Supported |
|-------------------------|-----------|
| Latest 0.x minor        | Yes       |
| Any earlier 0.x minor   | No        |

The latest minor at the time of writing is 0.4.

Supported Node.js: the `engines` field in `package.json` (currently
`>=22.12.0`). Versions of Node.js outside that range are not supported.

## Reporting a vulnerability

Report privately through GitHub private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**.

Do not open a public issue, pull request, or discussion for a suspected
vulnerability.

Include the affected version, steps to reproduce, and the impact you see.

## What to expect

- Acknowledgement within 3 business days.
- An initial assessment (accepted, needs more information, or declined) within
  10 business days.
- For accepted reports, a fix in the latest 0.x minor and a coordinated
  disclosure through a GitHub security advisory. Please keep the report
  confidential until the advisory is published.

These are targets from a small team, not guarantees.

## Scope

In scope: the `@miltonadina/devops` npm package and the hooks and skills it
installs into a project.

Out of scope:

- Consumer projects that install DevOPs.
- Third-party tools it works with (coding agents, MCP servers, scanners,
  Node.js, npm). Report those to their own maintainers.

## Release provenance

Releases are published to npm from a GitHub Actions workflow
(`.github/workflows/release-npm.yml`) with `npm publish --provenance`, which
attaches a signed attestation linking the package to the source commit and
workflow run.

To verify an installed package, run in a project that depends on it:

    npm audit signatures

The command checks registry signatures and provenance attestations for the
installed dependencies. The attestation is also shown on the package's npm
page.

Skill files are additionally signed with Sigstore (see
`.github/workflows/release-sign.yml`).

For the threat model and the defenses built into DevOPs itself, see
[docs/SECURITY.md](docs/SECURITY.md).
