# Upgrade guide

Read the [changelog](../CHANGELOG.md) and verify that the target release supports the installed
Node.js and Git versions. Perform upgrades during a maintenance window; Bareline supports one
serving process and does not support concurrent writers.

## Before upgrading

1. Set and securely retain a 32-byte base64url `security.masterKey`. It is required for authenticated
   backup/restore CLI operations and decrypting plugin, identity-provider, and backup-destination
   secrets.
2. Stop Bareline, create a backup on persistent storage, and verify it:

   ```sh
   bareline backup --output /safe/backup/bareline-before-upgrade --config config.yml
   bareline restore-verify --input /safe/backup/bareline-before-upgrade --config config.yml
   ```

3. Snapshot explicitly configured imported-repository roots separately. Copy the backup and the
   snapshot to another failure domain. Record the current application, image, Node, Git, and config
   versions.

## Install the release

For a source deployment, use the lockfile and the controlled native rebuild:

```sh
npm ci --ignore-scripts
npm run supply-chain:check
npm run rebuild:native
npm run build
npm run config:check -- --config config.yml
```

The `config:check` shorthand is optional; the equivalent direct command is
`node dist/cli/index.js config check --config config.yml`.

For a standalone bundle, verify both the signed release archive and its checksum before copying it
into service. The release workflow publishes the archive, its SHA-256 sidecar, a Sigstore bundle, and
the SBOM with its own Sigstore bundle:

```sh
sha256sum -c bareline-v1.1.0-linux-x64.tar.gz.sha256
cosign verify-blob bareline-v1.1.0-linux-x64.tar.gz \
  --bundle bareline-v1.1.0-linux-x64.tar.gz.sigstore.json \
  --certificate-identity 'https://github.com/Dylpickle-Studios/bareline/.github/workflows/release.yml@refs/tags/v1.1.0' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
cosign verify-blob bareline-v1.1.0.SBOM.spdx.json \
  --bundle bareline-v1.1.0.SBOM.spdx.json.sigstore.json \
  --certificate-identity 'https://github.com/Dylpickle-Studios/bareline/.github/workflows/release.yml@refs/tags/v1.1.0' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
tar -xzf bareline-v1.1.0-linux-x64.tar.gz
cd bareline-1.1.0-linux-x64
sha256sum -c SHA256SUMS
```

Substitute the target version and platform, and verify the SBOM sidecar with the same identity and
issuer before retaining it with the deployment record. For a container, use an immutable image
digest and verify its Cosign signature, SPDX SBOM attestation, and SLSA provenance attestation
according to the release record. Never treat `latest` or a mutable tag as the deployment identity.

## Start and validate

Start the new version and wait for `/readyz` to report healthy. Then run `bareline doctor` and test
login, private-repository access, HTTPS clone/push, SSH if enabled, LFS transfers, search status, and
enabled plugins. Rebuild search if the release notes or `doctor` indicate an interrupted index.

Configuration adds bounded Git input and concurrency settings (`limits.gitInputBytes`,
`limits.gitConcurrent`, and `limits.gitPending`); omitted values receive safe defaults. Unknown
configuration keys now fail startup, so remove stale settings rather than assuming they are ignored.
Client-provided `x-request-id` values are ignored; use the response header's generated value when
correlating support requests.

## Rollback and recovery

Do not downgrade an application across a database migration unless that release explicitly documents
support for it. Bareline migrations are forward-only. If the new version cannot start or the data
contract is incompatible, stop it, preserve logs and the recovery directory, restore the verified
backup into an isolated root first, and follow the release-specific recovery procedure. Validate the
isolated restore before replacing production data. Keep the pre-restore directory until the rollback
has been accepted.
