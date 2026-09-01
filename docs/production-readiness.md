# Production-readiness matrix

This is an engineering acceptance checklist, not a security certification. A checked item means
the control is implemented in this repository and has proportionate automated coverage. Items
marked **external** require deployment or independent-assessor evidence and cannot be satisfied by
unit tests alone.

## Implemented and regression-tested

- [x] Strict YAML configuration, unknown-key rejection, typed environment overrides, path-overlap
      checks, exact master-key validation, and production HTTPS requirements
- [x] Git argument isolation, disabled hooks/configuration, input/output/time ceilings, bounded
      concurrency, cancellation, and process-group cleanup across local, HTTP, and SSH transports
- [x] Central authorization for HTML, REST, Smart HTTP, SSH, LFS, search, and plugin contributions
- [x] Deny-by-default plugin permissions, explicit trusted-plugin warnings, package digests, and
      process-separated WebAssembly execution with no ambient filesystem/network/process access
- [x] WebAssembly memory, message, request, pending-work, timeout, and worker-lifecycle limits
- [x] HTTPS-only, credential-free, allowlisted outbound Git/mirror/plugin requests with DNS
      rebinding and private/reserved-address protection; redirects are not followed
- [x] Atomic staged backups, online SQLite snapshots including WAL sidecars, authenticated manifests,
      checksum verification, staged restore, rollback, and recoverable pre-restore data
- [x] Explicit backup policy scheduling, bounded retention, isolated restore verification, and
      conservative pruning of validated backup directories
- [x] Deterministic audit exports and master-key-authenticated checkpoints for independent
      retention and tamper-evident verification
- [x] Archived repository write blocking across web, Git HTTP, SSH, LFS, and mirror paths, plus
      bounded repository health reports
- [x] Signed HTTPS repository webhooks with encrypted secrets, hostname allowlists, bounded queues,
      finite retries, and no redirects
- [x] Optional bounded OTLP trace export with generated trace context and no trust in client trace IDs
- [x] Encrypted backup destination credentials, bounded HTTPS uploads, endpoint validation, and
      optional AES-256-GCM file envelopes
- [x] Modular route registration with a typed route context, request metrics, bounded metric labels,
      `/livez`, `/readyz`, and trusted `/metrics`
- [x] Deterministic bounded parser/property fuzzing and nightly CI execution
- [x] Lockfile/install-script policy checks, scriptless dependency installation, explicit native
      rebuilds, Dependabot configuration, image SBOM/provenance, and container signing workflow
- [x] Non-root container defaults with read-only root filesystem, no-new-privileges, dropped
      capabilities, tmpfs and Compose process/memory controls
- [x] Release bundle checksum generation, authenticated backup/restore release smoke testing, and
      graceful SIGTERM/SIGINT application shutdown

## Required external evidence before production

- [ ] **Independent security audit:** assess the source, dependencies, build artifacts, container,
      and deployed service. Track findings and retest; leave no unresolved critical/high finding.
- [ ] **Deployment egress policy:** enforce a network firewall or container policy that denies private,
      loopback, link-local, metadata, multicast, and other unintended destinations.
- [ ] **Backup/restore drill:** run against representative production data, imported roots, LFS,
      plugins, and the actual off-site destination; record recovery-point and recovery-time results.
- [ ] **Artifact verification:** pin and verify the exact base-image, GitHub Action, npm lockfile,
      release-bundle, SBOM, provenance, and signature digests used by the deployment.
- [ ] **Operational validation:** run browser/accessibility coverage, load/soak and failure-injection
      tests, certificate/key rotation, alert routing, log retention, and a clean-machine smoke.
- [ ] **Security contact:** configure and test a private vulnerability-reporting channel before
      production exposure.

## Release gate

For every release, run from a clean checkout:

```sh
npm ci --ignore-scripts
npm run supply-chain:check
npm run rebuild:native
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:fuzz
npm audit --omit=dev
npm run release:bundle
npm run release:verify
npm run smoke:release
```

Run browser tests and container smoke separately in CI or a clean environment. Record command
versions, results, artifact digests, and any environment-only exceptions in the release record.

## Explicit core exclusions

Bareline intentionally does not add pull requests, CI/CD runners, registries, deployments, Pages,
environments, project management, or DevOps dashboards. It provides repository-centred issues,
wikis, releases, patches, forks, and branch operations; these remain focused Git-hosting workflows,
not a general project-management system.
