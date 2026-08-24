# Production-readiness matrix

This document is the acceptance checklist for the original product specification. A checked item
means the behavior is implemented and covered proportionately by automated tests. The project must
remain labeled pre-1.0 until every **Required before 1.0** item is checked.

## Required before 1.0

- [x] AGPL-3.0-only license, centralized branding metadata, contributor and security policies
- [x] Strict TypeScript modular monolith, validated YAML configuration, structured/redacted logging
- [x] Transactional SQLite migrations, foreign keys, WAL, indexes, opaque repository storage
- [x] Safe bounded Git process abstraction with real-repository tests and no shell interpolation
- [x] Accounts, Argon2id passwords, atomic first-admin bootstrap, sessions, CSRF and throttling
- [x] Hashed/scoped/expiring personal access tokens and audited SSH public-key management
- [x] Passkey enrollment/authentication with expiring single-use challenges and counter updates
- [x] Public/private repository authorization shared by HTML, API, Smart HTTP and SSH
- [x] Smart HTTP clone/fetch/push and external OpenSSH forced-command integration
- [x] Repository tree/blob/raw/Markdown/history/commit/branch/tag/compare/blame/archive/feed views
- [x] Bare-repository web commits and branch/tag mutation with compare-and-swap ref updates
- [x] Local Git LFS batch/upload/download backend with digest, size and rendering protections
- [x] Incremental private-aware SQLite FTS5 indexing, rebuild/status CLI and post-write jobs
- [x] Groups, group-owned repositories, grants, transfers, rename, visibility and delayed trash
- [x] README, `.gitignore`, and license repository initialization templates in one atomic commit
- [x] Invite-mode lifecycle with digest-only, expiring, single-use administrator-created links
- [x] User profile, email-visibility controls, and bounded raster avatar storage and serving
- [x] Append-oriented audit storage and administrator users/repositories/plugins/search/system pages
- [x] Versioned plugin manifests, deny-by-default permissions, encrypted settings and storage isolation
- [x] Trusted-plugin warnings and process-separated import-free WebAssembly sandbox execution
- [x] Plugin SDK, mocked playground, downloadable example package and lifecycle integration tests
- [x] Command palette, light/dark/system themes, responsive CSS and session revocation
- [x] Online backup, checksum verification and recoverable confirmed restore
- [x] Non-root Docker image, Compose example and platform-native standalone application bundle
- [x] OIDC authorization-code/PKCE provider integration and identity linking
- [x] LDAP/LDAPS provider integration with escaped filters and bounded searches
- [x] Recovery codes and administrator-assisted password recovery without secret disclosure
- [x] Complete passkey list/rename/remove UI and logout-everywhere semantics after credential changes
- [x] Repository settings UI: collaborators, visibility, default branch, rename, transfer and trash
- [x] Protected branches, read-only deploy keys, allowlisted mirrors, templates, activity and repository discovery
- [x] Trusted signer lifecycle and encrypted S3-compatible backup destinations/uploads
- [x] Existing bare/working-tree import UI and CLI restricted to configured allowlisted roots
- [x] Browser file upload and multi-file commits with hard aggregate limits
- [x] Group creation/member/permission administration UI and API
- [x] Signed commit/tag verification details with explicitly non-trusting identity language
- [x] Structured per-file/hunk diff model, anchors, collapsing, rename/binary states and intraline hints
- [x] Accurate split diff alignment and progressive huge-diff loading with file/line/byte hard ceilings
- [x] Protected before/after and overlay image diffs with bounded metadata decoding
- [x] Explicit submodule presentation and safe outbound-link policy
- [x] Comprehensive versioned REST API for users, groups, repositories, refs, files and administration
- [x] Endpoint-specific core REST OpenAPI request/response schemas, pagination/filter metadata and contract tests
- [x] Plugin route/tab/command/event contribution dispatch through checked capability APIs
- [x] Sandboxed plugin structured capability bridge beyond the current import-free numeric ABI
- [x] Repository push event fan-out and incremental plugin/search handling outside the push latency path
- [x] Structured repository/branch/tag/web-commit event publication through the plugin event boundary
- [x] Uploaded plugin archive validation and allowlisted npm/HTTPS Git retrieval without install scripts
- [x] Administrative CLI: doctor, user lifecycle, repo import/rescan, SSH setup and restore verification
- [x] Native HTTPS startup path and tested proxy/TLS examples
- [x] Documentation set and built-in documentation search covering every requested topic
- [x] Attractive status-specific 400/401/403/404/409/413/429/500/503 pages and safe diagnostics
- [x] Playwright install/bootstrap/repository/settings/plugin/mobile/accessibility critical flows
- [x] Explicit security regression suite for every threat-model category
- [x] Audited administrator runtime settings for registration, anonymous access, retention, and resource limits
- [x] Administrator authentication-provider status without exposing deployment secrets or trust configuration
- [x] Finish every documented plugin contribution category (renderers, Markdown, auth, themes, and admin UI)
- [x] Finish original-spec API coverage and exact schema audit rather than relying on generic contracts
- [x] Standalone bundle with bundled Node runtime, native dependencies, and startup/backup/restore smoke
- [ ] Docker image build and health smoke test
- [x] Release-bundle startup/backup/restore smoke test in the development environment

## Explicit core exclusions

- [x] No issues, pull/merge requests, CI/CD, runners, project management, registries, deployments,
      Pages, environments, or DevOps dashboards in core

## Release gate

Before removing the pre-1.0 warning: run strict type checking, lint, formatting check, unit/database/
security/API/integration tests, Playwright at desktop and mobile widths, `npm audit`, Docker smoke
tests, and a clean-machine standalone-bundle smoke test. Record the results in the release notes.
