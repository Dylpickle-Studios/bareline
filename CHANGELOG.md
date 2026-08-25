# Changelog

All notable changes follow Keep a Changelog. This project uses semantic versioning after 1.0.

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
