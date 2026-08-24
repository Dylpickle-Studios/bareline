# Architecture

Bareline is a modular monolith. Fastify HTML and REST routes call the same domain services. SQLite
holds identities, policy, logical repository metadata, sessions, audit events, indexes, and plugin
state; Git remains authoritative for repository content.

Hosted bare repositories use random 256-bit storage identifiers, sharded by their first byte. Owner
and repository renames therefore change only database metadata. Imports are restricted to explicitly
configured roots and are read-only by default.

Git operations use argument arrays and shared process-safety controls: a sanitized environment,
disabled global/system configuration and hooks, cancellation, timeouts, and output limits. Buffered
operations use the central runner; Smart HTTP, SSH, and archives use streaming adapters with those
same controls plus the shared repository resolver and authorization service.

SQLite is configured for foreign keys and WAL. Migrations are ordered, checksummed, and transactional
where SQLite permits. One serving process is supported; horizontal multi-writer deployments are not.
