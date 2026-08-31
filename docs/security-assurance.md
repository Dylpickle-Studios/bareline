# Security assurance and release evidence

Bareline's automated checks are a regression net, not an independent security certification. Before
exposing an installation to untrusted users, the operator or release owner must retain evidence for
the following controls:

## Required release evidence

- `npm ci --ignore-scripts`, `npm run supply-chain:check`, the explicit native rebuild, type checking,
  lint, unit/integration tests, parser fuzzing, browser tests, `npm audit --omit=dev`, release smoke,
  and container smoke all pass from a clean checkout. CodeQL must report no unresolved blocking
  findings.
- The release bundle's SHA-256 sidecar, signed archive, and signed SPDX SBOM are verified against the
  release workflow identity; `npm run release:verify` checks the extracted bundle's file list and
  hashes. The container is published with signed SPDX SBOM and SLSA provenance attestations plus a
  keyless signature over its immutable image digest.
- A backup is created from a quiesced service, verified, restored into an isolated data root, and
  exercised with login, private-repository browsing, clone, push, LFS, search rebuild, and plugin
  validation. Imported repositories and external backup destinations are tested separately.
- Audit events are exported to independently retained storage, then covered by a
  master-key-authenticated checkpoint that is verified from the production database. Record the
  checkpoint range, storage location, retention controls, and verification result with the release
  evidence.
- Deployment egress policy blocks private, loopback, link-local, metadata, and otherwise reserved
  destinations for every application-controlled outbound request. Application URL validation is
  defense in depth; a firewall or network policy remains required.

## Independent audit gate

An external security review is a release gate for production, not a test that this repository can
claim to have performed. Commission an independent assessor to review source, dependencies, the
release/container build, and a deployed instance. The minimum scope is:

- authentication, session/CSRF, authorization across HTML/API/Smart HTTP/SSH, and audit integrity;
- Git argument and configuration isolation, path/archive/LFS handling, parser ceilings, and race
  behavior;
- plugin manifest, permission, WebAssembly ABI, worker isolation, resource limits, and trusted-code
  warnings;
- DNS-aware SSRF protection, redirects, proxy behavior, OIDC/LDAP trust boundaries, and backup
  encryption/integrity;
- dependency provenance, install scripts, image/bundle artifacts, container hardening, and secrets.

Record findings, owners, affected versions, compensating controls, and retest results. No unresolved
critical or high finding should remain at the production approval decision.
