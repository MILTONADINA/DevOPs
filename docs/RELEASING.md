# Releasing to npm

How a version of `@miltonadina/devops` reaches npm. The rules are in
`specs/release/npm-package.md`; the workflow is `.github/workflows/release-npm.yml`.

## One-time setup

1. **The npm scope.** `@miltonadina` must be your npm username or an npm organization
   you own. Sign in at npmjs.com and turn on two-factor authentication.
2. **The approval gate.** In the GitHub repository, go to Settings → Environments and
   create an environment named `npm-release`. Add yourself as a required reviewer and
   allow deployments from tags only (`v*`). Every publish waits for that approval.
3. **The first release's token.** npm can link a package to a workflow (trusted
   publishing) only once the package exists, so the first release needs a token:
   - On npmjs.com, create a granular access token with read and write access to
     `@miltonadina/devops` (or to the scope, before the package exists), with a short
     expiry.
   - Add it as the secret `NPM_TOKEN` on the `npm-release` environment, not as a
     repository secret.
4. **After the first release: trusted publishing.**
   - On npmjs.com, open the package's Settings → Trusted Publisher and choose GitHub
     Actions with repository `MILTONADINA/DevOPs`, workflow `release-npm.yml` and
     environment `npm-release`.
   - Then delete the `NPM_TOKEN` secret and revoke the token. Later releases
     authenticate with OIDC and store no secret.

## Each release

1. **Re-sign the skills if any changed.** CI's `package-smoke` job fails when a skill
   no longer matches its signed manifest entry. Run the signing workflow on the
   branch, which commits fresh signatures back to it:
   `gh workflow run release-sign.yml --ref <branch>`.
2. **Set the version.** Bump `version` in `package.json`, `.claude-plugin/plugin.json`
   and the `**Current version**` line of `governance/VERSION.md`. They must agree
   (`node scripts/check-repo-hygiene.mjs`).
3. **Write the changelog.** Rename `## [Unreleased]` in `CHANGELOG.md` to
   `## [X.Y.Z] — YYYY-MM-DD`, and start a new empty `## [Unreleased]` above it.
4. **Merge.** Open a pull request and merge it once every check passes.
5. **Tag main.** On main, run `git tag -a vX.Y.Z -m "vX.Y.Z"`, then
   `git push origin vX.Y.Z`. This repository's deploy gate asks for your approval
   marker before it lets the tag push through.
6. **Approve.** The `Release to npm` workflow verifies the tag, the changelog, the
   tests, the installed package and every skill signature. It then waits for your
   approval of the `npm-release` environment, and publishes with a provenance
   attestation. `release-sign.yml` also verifies the signatures on the same tag.
7. **Check.**
   - `npm view @miltonadina/devops version` prints X.Y.Z.
   - `npx @miltonadina/devops@X.Y.Z version` runs.
   - The npm page shows the provenance badge linking to the workflow run.

## Before the first release: a local dry run

```bash
bash scripts/package-smoke.sh                    # pack, install, run every command
npm publish --dry-run --access public            # shows exactly what would upload
```

Neither command uploads anything.
