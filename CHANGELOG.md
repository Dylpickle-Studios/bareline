# Changelog

All notable changes follow Keep a Changelog. This project uses semantic versioning after 1.0.

## [Unreleased]

### Added

- Stateless scheduled backup policies with bounded retention, dry-run/status commands, isolated
  restore verification, and symlink-safe pruning.
- Deterministic audit JSONL exports and HMAC-authenticated integrity checkpoints for independent
  off-host retention and verification.
- Repository archival/read-only controls, bounded Git health reports, and transport-level write
  blocking for archived repositories.
- Repository-scoped, HMAC-signed webhooks with encrypted one-time secrets, SSRF-aware HTTPS
  allowlists, durable bounded retries, and dead-letter state.
- Opt-in OTLP/HTTP trace export with generated trace context and bounded in-memory buffering.

## [1.1.0] - 2026-08-27

### Added

- Strict recursive configuration validation, bounded Git input/concurrency controls, DNS-aware
  outbound policy, IPv4/IPv6 CIDR matching, and trusted request-ID generation.
- Process-separated WebAssembly plugin execution with memory, heap, message, queue, timeout, and
  package-integrity limits; trusted plugin enablement remains an explicit risk decision.
- Atomic, authenticated backup manifests, online SQLite/WAL capture, staged restore with rollback,
  release checksums, parser fuzzing, supply-chain policy checks, and readiness/metrics endpoints.
- CodeQL/static-analysis workflow, immutable CI action and base-image pins, container SBOM/provenance,
  Cosign image signing, and a tag-triggered release workflow that publishes signed standalone
  archives and SPDX SBOMs.

### Changed

- HTTP routes are registered through focused modules with a typed application context.
- Remote Git/npm plugin and mirror retrieval rejects credentials, redirects, DNS rebinding, and
  private/reserved destinations; npm plugins require an exact semantic version.
- Production backup and restore CLI operations require an authenticated `security.masterKey`.
- The standalone release bundle and OpenAPI metadata now derive their version from package metadata.
- The upgrade guide documents signed bundle/SBOM verification, immutable image verification, and
  rollback-safe backup and restore steps.

### Security

- Client-provided `x-request-id` values are ignored to prevent log and audit correlation spoofing.
- Security reporting is documented through the repository's private GitHub Security Advisory flow.

## [1.0.0] - 2026-08-25

### Added

- Initial modular application, configuration, migrations, authentication, repository storage and
  browsing, Git Smart HTTP, OpenSSH forced-command integration, audit logging, responsive UI, and
  security-focused integration tests.
- Complete implementation of the pre-1.0 acceptance checklist in
  `docs/production-readiness.md`, including Git LFS, plugins, groups, backups, mirrors, protected
  branches, OIDC/LDAP/reverse-proxy authentication, recovery codes, the versioned REST API, a
  non-root Docker image, and a self-contained standalone application bundle.

### Fixed

- Disabled/banned user accounts could still authenticate over SSH and personal access tokens;
  both paths now check account status like the web session path does.
- A malformed Git HTTP backend response header could crash the server process instead of failing
  the single request.
- Archive downloads that exceeded the configured size limit hung instead of failing immediately.
