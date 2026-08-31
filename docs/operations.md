# Operations and backups

## Configuration

Configuration is YAML and is validated before startup. Relative storage paths are resolved, unknown
or malformed values fail with an actionable error, and `${UPPER_CASE_NAME}` placeholders read
deployment secrets from the environment. Precedence is: schema defaults, YAML values, documented
`BARELINE_*` environment overrides, then the audited database overrides for the limited settings
shown at `/admin/settings`. Those runtime overrides cover registration, anonymous public browsing,
session/trash retention, and bounded repository rendering limits; TLS, paths, executables, provider
trust endpoints, and credentials remain deployment-only configuration. Run `bareline config check
--config config.yml` before restarting.

Keep hosted repositories, trash, LFS, and the SQLite database on persistent storage. Only explicitly
configured `storage.importRoots` may contain imported repositories; the application never scans the
host filesystem. Working-tree imports are browse-only for server writes.

## Backups

Set `security.masterKey` before creating production backups. It authenticates the manifest as well
as protecting encrypted plugin/provider and destination credentials. Stop Bareline, or provide an
equivalent quiesce/maintenance window, before running:

```sh
bareline backup --output /backup/bareline-YYYYMMDD --config config.yml
bareline restore-verify --input /backup/bareline-YYYYMMDD --config config.yml
```

The command stages the backup outside the destination and publishes it with one rename. It uses
SQLite's online backup API and copies hosted repositories, repository trash, LFS, configuration,
installed plugin packages, plugin trash, and database-backed plugin data without following
symlinks. It writes a SHA-256 file manifest and an HMAC-SHA-256 manifest authentication value last.
Imported bare and working-tree repositories remain in their administrator-managed roots; the
manifest inventories their logical names and paths, and the operator must snapshot those roots
separately. Copy every part to a different failure domain.

Filesystem snapshots are safe when the filesystem provides a consistent point-in-time view across
the database and Git/LFS roots. Otherwise use the built-in command. Never copy a live SQLite file
with an ordinary file copy while writes continue.

### Scheduled policy and retention

Run the policy command from a trusted scheduler while Bareline is stopped or in a maintenance
window. The policy is deliberately explicit: every invocation specifies an interval of 1–168 hours
and a retention count of 1–365. It does not store a hidden schedule in the database or configuration.
This makes the deployment's backup objective reviewable in its systemd timer, cron entry, or other
orchestrator definition. The output must be outside `storage.data`, on a separately mounted durable
volume where possible; the policy rejects locations inside live application storage.

```sh
# Inspect whether a backup is due; this performs authenticated manifest checks.
bareline backup policy status --output /backup/bareline --interval-hours 24 --retain 14 \
  --config config.yml

# Create one only when due, run an isolated restore verification, then retain the newest 14.
bareline backup policy run --output /backup/bareline --interval-hours 24 --retain 14 \
  --config config.yml

# Show the output directory and retention removals without writing or deleting anything.
bareline backup policy run --output /backup/bareline --interval-hours 24 --retain 14 \
  --dry-run --config config.yml
```

Use `--force` only for a deliberate additional recovery point; it still performs isolated restore
verification and enforces retention. Each policy backup is named `bareline-<UTC timestamp>-<UUID>`.
Malformed or unauthenticated backup directories are reported as `invalid` in status and are never
deleted automatically—investigate them before removal. A successful policy run verifies checksums
and the manifest HMAC, copies the backup into a new temporary restore root without following
symlinks, and performs SQLite `quick_check`; it never touches live data.

## Restoring backups

`restore-verify` validates the file list, SHA-256 checksums, and manifest HMAC, then materializes
the backup in a temporary root and runs SQLite `quick_check`; it never replaces live data. Restore
is intentionally a stopped-service operation:

```sh
bareline restore --input /backup/bareline-YYYYMMDD \
  --config config.yml --confirm-replace
```

Restore stages every target and checks that the swaps are on compatible filesystems before moving
current data into a timestamped `pre-restore-*` recovery directory. A failed swap rolls back the
active targets where possible. Keep the recovery directory until the application has passed login,
private browsing, clone, push, LFS download, and search checks. The backup's `config.yml` is saved
as `restored-config.yml` in that recovery directory; it is not silently made active.

## Encrypted S3-compatible destinations

Bareline can store S3-compatible destination credentials encrypted with `security.masterKey`; raw
credentials are never accepted as command-line arguments. Set `BARELINE_BACKUP_ACCESS_KEY` and
`BARELINE_BACKUP_SECRET_KEY`, then run:

```sh
bareline backup destination-add --actor-id 1 --name offsite \
  --endpoint https://s3.example.net --region eu-west-1 --bucket bareline --config config.yml
bareline backup destination-list --config config.yml
```

`backup create` produces a directory, while `backup upload --file` accepts a regular file only; the
CLI does not implicitly archive a directory. If the off-site system requires one object, create an
archive with an approved, symlink-safe archival tool, then upload that file:

```sh
tar --sort=name --owner=0 --group=0 --numeric-owner \
  -C /backup -czf /safe/staging/bareline-2026-08-24.tar.gz bareline-2026-08-24
bareline backup upload --destination-id 1 --file /safe/staging/bareline-2026-08-24.tar.gz \
  --object-name bareline-2026-08-24.tar.gz --config config.yml
```

After retrieval, inspect and extract the archive into a new directory, run `restore-verify` on that
directory, and only then run `restore`. The upload uses AWS Signature Version 4 and HTTPS. To encrypt
the archive before upload, set `BARELINE_BACKUP_ENCRYPTION_KEY` and add
`--encrypted-output /safe/staging/backup.enc`. Bareline writes a versioned AES-256-GCM envelope and
uploads that file. Keep this key outside both the Bareline host and destination; losing it makes the
archive unrecoverable. Endpoint URLs with credentials, non-HTTPS schemes, redirects, and private or
reserved resolved addresses are rejected. A network egress policy is still required.

## Search index

Git remains authoritative. Search documents and interrupted jobs are reconstructable. Use
`bareline search status`, `bareline repo rescan --owner OWNER --name REPO`, or `bareline search
rebuild`. Pushes enqueue work; indexing does not hold the Git push response open for a full scan.

## Storage and deletion

Hosted repositories use opaque physical identifiers. Logical rename and transfer do not rename Git
directories. Deletion moves hosted repositories into configured trash and records an audit event.
The server purges only validated application-managed trash entries after `repositoryTrashDays` and
records a second audit event. External imported repositories are never removed by this process.

## Audit export and integrity checkpoints

Administrators can export the audit history as deterministic JSON Lines. Each line contains an event
and the SHA-256 chain value after that event. Send the output to restricted, append-only storage; it
can contain IP addresses and administrative activity metadata.

```sh
bareline audit export --output /safe/audit/audit-$(date +%F).jsonl --config config.yml
```

Create a checkpoint after an export and retain it in a separate failure domain. A checkpoint covers
the complete ordered prefix through its last event ID and is HMAC-SHA-256 authenticated with
`security.masterKey`. The master key is never written to either file. Existing destination files are
never replaced, so choose unique filenames.

```sh
bareline audit checkpoint --output /safe/audit/checkpoint-$(date +%F).json --config config.yml
bareline audit verify --checkpoint /safe/audit/checkpoint-2026-08-31.json --config config.yml
```

Verification authenticates the checkpoint, then recomputes its covered audit prefix from the live
database. It detects altered, removed, reordered, or inserted events in that prefix. Events added
after the checkpoint do not invalidate it. This is evidence of tampering only while checkpoints and
the master key are independently protected: an attacker who can modify both the database and every
checkpoint, or who obtains the master key, can forge matching data. Automate export/checkpointing and
copy the checkpoint off-host before relying on this control.

## Troubleshooting

Start with `bareline doctor`, `bareline config check`, and `git --version`. Check filesystem
ownership, free space, SQLite integrity, certificate readability, public URL, proxy reachability,
and OpenSSH forced-command output. Use the request ID from an error page or response `x-request-id`
to find the structured log entry; the application generates this value and does not trust a
client-supplied correlation header. Logs deliberately omit passwords, cookies, raw tokens, keys, and
repository contents.

## Webhooks and trace export

Repository administrators can create signed webhook endpoints through the REST API. The response
returns a random webhook secret once; store it in the receiver's secret store and validate the
`x-bareline-signature-256` HMAC before processing a payload. Delivery is HTTPS-only, requires an
exact hostname allowlist in `webhooks.allowedHosts`, rejects redirects and unsafe DNS results, and
uses a bounded persistent queue with exponential retry. Failed deliveries are retained for audit;
they are never retried indefinitely.

Set `observability.otlpEndpoint` only when its exact HTTPS hostname is listed in
`observability.allowedHosts`. Bareline then emits bounded OTLP/HTTP JSON server spans and exposes a
new generated `traceparent` response header. Incoming trace headers are intentionally ignored, so
untrusted clients cannot choose log or telemetry correlation identifiers.
