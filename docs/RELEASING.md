# Releasing to npm

How a version of `@miltonadina/devops` reaches npm. The rules are in
`specs/release/npm-package.md`; the workflow is `.github/workflows/release-npm.yml`.

## One-time setup

1. **The npm scope.** `@miltonadina` must be your npm username or an npm organization
   you own. Sign in at npmjs.com and turn on two-factor authentication.
2. **The approval gate.** In the GitHub repository, go to Settings → Environments and
   create an environment named `npm-release`. Add yourself as a required reviewer and
   allow deployments from tags only (`v*.*.*`). Every publish waits for that approval.
   (Done for this repository on 2026-10-11: reviewer MILTONADINA, tag rule `v*.*.*`.)
3. **The first release's token.** npm can link a package to a workflow (trusted
   publishing) only once the package exists, so the first release needs a token.
   Running `npm trust github` before the package existed did not help: the first
   v0.4.0 run (38191691780) had no token and failed with `ENEEDAUTH`.
   - On npmjs.com, create a granular access token with read and write access and a
     short expiry. Under "Packages and scopes", select the `@miltonadina` scope; the
     package does not exist yet.
   - Tick "Bypass two-factor authentication". It is off by default, and without it
     an account that requires 2FA for publishing makes the CI publish fail, because
     the workflow cannot enter a one-time password. GitHub's changelog of 2026-07-31
     says such tokens lose direct publishing around January 2027.
   - Add it as the secret `NPM_TOKEN` on the `npm-release` environment, not as a
     repository secret.
4. **After the first release: trusted publishing.**
   - On npmjs.com, open the package's Settings → Trusted Publisher and choose GitHub
     Actions with repository `MILTONADINA/DevOPs`, workflow `release-npm.yml` and
     environment `npm-release`. From a terminal signed in to npm, this does the same:
     `npm trust github @miltonadina/devops --file release-npm.yml --repository MILTONADINA/DevOPs --environment npm-release --allow-publish`.
   - npm says a new link must be used for a successful publish within two days. Set
     it up shortly before the next release, and check it with `npm trust list
     @miltonadina/devops`.
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
   tests, the installed package, that packing twice gives byte-identical tarballs
   (`node scripts/pack-twice.mjs`; run it locally to see which entries differ) and every
   skill signature. It then waits for your
   approval of the `npm-release` environment, and publishes with a provenance
   attestation. `release-sign.yml` also verifies the signatures on the same tag.
7. **Check.**
   - `npm view @miltonadina/devops version` prints X.Y.Z.
   - `npx @miltonadina/devops@X.Y.Z version` runs.
   - The npm page shows the provenance badge linking to the workflow run.
   - The `sbom` job, which runs after `publish`, attaches `devops-vX.Y.Z.cdx.json`, a
     CycloneDX SBOM of the runtime dependencies, to the GitHub release (it creates the
     release if none exists) and to the workflow run as the `sbom` artifact. It comes
     from `npm sbom --sbom-format cyclonedx --omit dev`; run that after `npm ci` to see
     the same file. npm names the root component after the checkout directory; the
     package identity is in its `bom-ref` and `purl`. The job holds `contents: write`;
     the `publish` job's permissions and environment are unchanged.

## Support and end-of-life

- The latest minor is supported and receives fixes.
- The previous minor is security-only for 90 days after the latest minor is released,
  then it is end-of-life. Earlier minors are end-of-life.
- The Node.js floor changes only in a minor release, and that release carries a
  CHANGELOG note. The floor is `>=22.12.0`, the `engines.node` field in `package.json`.

`SECURITY.md` points here for the supported versions.

## Before the first release: a local dry run

```bash
bash scripts/package-smoke.sh                    # pack, install, run every command
npm publish --dry-run --access public            # shows exactly what would upload
```

Neither command uploads anything.
