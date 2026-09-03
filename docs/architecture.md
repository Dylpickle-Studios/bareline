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
same controls plus the shared repository resolver and authorization service. Git work is bounded by
active and pending concurrency limits, and detached process groups are terminated on cancellation or
timeout.

The HTTP surface is registered through focused route modules under `src/app/routes/` with a typed
application context. REST routes are split by repository management/content, account, and
administration/plugin responsibility; each module receives the same narrow context instead of
reaching into app construction. Request, Git, plugin, backup, and queue metrics are bounded and
exposed through trusted `/metrics`; `/livez` and `/readyz` serve separate orchestration purposes.

Repository enhancements remain metadata around Git rather than alternate representations of Git
objects. Administrators may clone a public HTTPS remote into new managed bare storage after a
bounded metadata preview; failures remove partial storage before any repository becomes visible.
A minute worker processes bounded batches of due mirrors; remote hosts require an explicit
YAML allowlist. Template creation fetches refs into a fresh opaque bare repository and removes both
storage and metadata if population fails. Activity stores bounded event summaries, not commits or
file content. Trusted signer records annotate Git's verification result without changing it.

Webhook endpoints are repository metadata with encrypted per-endpoint HMAC secrets. Events enter a
bounded durable queue; a worker resolves each HTTPS allowlisted destination through the outbound
policy, signs the exact JSON payload, and retries only a finite number of times. Optional OTLP
export follows the same HTTPS/allowlist model and never trusts client-provided trace context.

SQLite is configured for foreign keys and WAL. Migrations are ordered, checksummed, and transactional
where SQLite permits. Backups use the online SQLite API plus staged filesystem copies, authenticated
manifests, and recoverable restore swaps. One serving process is supported; horizontal multi-writer
deployments are not.
