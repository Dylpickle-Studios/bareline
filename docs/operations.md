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

Run `bareline backup --output /backup/bareline-YYYYMMDD --config config.yml`. The command uses
SQLite's online backup API and copies hosted repositories, repository trash, LFS, configuration,
installed plugin packages, plugin trash, and database-backed plugin data without following
symlinks. It writes a SHA-256 manifest last. Imported bare and working-tree repositories remain in
their administrator-managed roots; the manifest inventories their logical names and paths, and the
operator must snapshot those roots separately. Copy every part to a different failure domain.

Filesystem snapshots are safe when the filesystem provides a consistent point-in-time view across
the database and Git/LFS roots. Otherwise use the built-in command. Never copy a live SQLite file
with an ordinary file copy while writes continue.

## Restoring backups

## Encrypted S3-compatible destinations

Bareline can store S3-compatible destination credentials encrypted with `security.masterKey`; raw
credentials are never accepted as command-line arguments. Set `BARELINE_BACKUP_ACCESS_KEY` and
`BARELINE_BACKUP_SECRET_KEY`, then run:

```sh
bareline backup destination-add --actor-id 1 --name offsite \
  --endpoint https://s3.example.net --region eu-west-1 --bucket bareline --config config.yml
bareline backup destination-list --config config.yml
bareline backup upload --destination-id 1 --file /backup/bareline.tar.zst \
  --object-name bareline-2026-08-24.tar.zst --config config.yml
```

The upload uses AWS Signature Version 4 and HTTPS. To encrypt a backup archive before upload, set a
separate 32-byte base64url `BARELINE_BACKUP_ENCRYPTION_KEY` and add
`--encrypted-output /safe/staging/backup.enc`. Bareline writes a versioned AES-256-GCM envelope and
uploads that file. Keep this key outside both the Bareline host and destination; losing it makes the
archive unrecoverable. Endpoint URLs with credentials or non-HTTPS schemes are rejected.

Verify first with `bareline restore-verify --input BACKUP`. Stop the application, then run
`bareline restore --input BACKUP --confirm-replace`. Restore refuses to proceed without explicit
confirmation and moves existing data into a timestamped pre-restore directory. Start the server and
test login, private browsing, clone, push, LFS download, and search. Rebuild search when necessary.

## Search index

Git remains authoritative. Search documents and interrupted jobs are reconstructable. Use
`bareline search status`, `bareline repo rescan --owner OWNER --name REPO`, or `bareline search
rebuild`. Pushes enqueue work; indexing does not hold the Git push response open for a full scan.

## Storage and deletion

Hosted repositories use opaque physical identifiers. Logical rename and transfer do not rename Git
directories. Deletion moves hosted repositories into configured trash and records an audit event.
The server purges only validated application-managed trash entries after `repositoryTrashDays` and
records a second audit event. External imported repositories are never removed by this process.

## Troubleshooting

Start with `bareline doctor`, `bareline config check`, and `git --version`. Check filesystem
ownership, free space, SQLite integrity, certificate readability, public URL, proxy reachability,
and OpenSSH forced-command output. Use the request ID from an error page to find the structured log
entry. Logs deliberately omit passwords, cookies, raw tokens, keys, and repository contents.
