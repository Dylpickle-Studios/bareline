# Administration

## Users, groups, and permissions

Groups are lightweight repository owners with member, manager, and owner roles. Repository access
is centralized: read can browse/clone/archive; write adds pushes and web commits; admin manages
settings and collaborators; owner alone can transfer or delete. Private names are filtered from
listings, search, feeds, API responses, and palette results.

Disabling a user revokes active sessions. The final active administrator cannot be disabled or
demoted. Personal access tokens are random, shown once, hashed at rest, scoped, expiring, revocable,
and record last use. Raw credentials never enter audit metadata.

## Authentication providers

Password authentication uses Argon2id. Passkeys require HTTPS (except localhost), bind challenges
to the configured public origin/RP ID, require user verification, and update authenticator counters.
OIDC providers should use discovery, PKCE, state, nonce, exact redirect URIs, and encrypted client
secrets. LDAP deployments should use LDAPS or StartTLS, escape filters, bind with the presented user
only after a bounded lookup, and never log bind passwords. Proxy authentication is safe only when
direct clients cannot set the identity header and requests arrive from configured proxy addresses.

## Search and storage

SQLite runs with foreign keys and WAL. Git is authoritative; the FTS5 index and jobs are rebuildable.
Indexing is incremental and push paths enqueue work instead of blocking on a repository scan. Use
`bareline search rebuild` after repair or migration. Hosted repository paths use opaque identifiers;
imports are restricted to configured roots and the application never scans the whole filesystem.

## Audit logs and security

Audit records are append-only through SQLite triggers and cover authentication, credentials,
permissions, destructive repository actions, plugins, and configuration-sensitive changes. Limit
IP retention according to local policy. Review the threat model and SECURITY.md before exposing an
installation publicly.

## REST API and OpenAPI

The versioned API lives under `/api/v1/`; interactive OpenAPI documentation is at `/api/docs`.
Authenticate with `Authorization: Bearer TOKEN`. Collection endpoints use bounded pagination and
all resource access passes through the same services as HTML routes.

## Reverse proxy and HTTPS

Caddy: `reverse_proxy 127.0.0.1:3000`. nginx: proxy to the same address and set `Host`,
`X-Forwarded-Proto`, and `X-Forwarded-For` after clearing client values. Traefik should use an
internal Docker network and never publish the application port when proxy authentication is used.

## Updates and recovery

Stop writes, take a verified backup, replace the application bundle/image, and start it. Migrations
are ordered and transactional where SQLite permits; failures stop startup without discarding data.
Retain the prior application bundle until repository browsing, clone/push, LFS, and login checks pass.
