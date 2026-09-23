# Personal release signing

DevOPs releases use two signatures: a human SSH-signed Git tag and keyless
Sigstore signatures on universal skills. The private SSH key stays on the
owner's machine; CI signs skills with the release workflow's OIDC identity.

## One-time SSH tag setup

Generate a dedicated Ed25519 key with a passphrase, then add its **public**
half to GitHub as a signing key. GitHub documents both the
[key setup](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent)
and [signing-key registration](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account).

```bash
ssh-keygen -t ed25519 -f ~/.ssh/devops_signing -C "DevOPs release signing"
ssh-add --apple-use-keychain ~/.ssh/devops_signing  # macOS; enter passphrase locally
gh ssh-key add ~/.ssh/devops_signing.pub --type signing --title "DevOPs release signing"
git config --local gpg.format ssh
git config --local user.signingkey ~/.ssh/devops_signing.pub
git config --local tag.gpgsign true
```

Configure `gpg.ssh.allowedSignersFile` with a project-local, ignored file
containing the verified Git email followed by the public key. This lets
`git tag -v` verify tags locally. Never commit the private key or its
passphrase.

## Release sequence

1. Dispatch `release-sign.yml` on the release branch. It commits skill
   signatures, bundles, and the manifest to that branch.
2. Review and merge the release PR after CI and security checks pass.
3. On the merged `main` commit, run `git tag -s vX.Y.Z -m "DevOPs vX.Y.Z"`,
   then `git tag -v vX.Y.Z`. Push the tag without force.
4. Wait for the tag-triggered `release-sign.yml` verification. Publish the
   GitHub Release only after it passes.

See [the v0.3.0 release spec](specs/release/v0.3.0.md) and
[skill-signing guide](docs/SKILL_SIGNING.md) for the remaining release gates.
