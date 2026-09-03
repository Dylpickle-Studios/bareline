# Getting Started

Bareline is a focused Git server and browser. It provides repositories, history, diffs, search,
SSH and HTTPS transport, plus repository-centred issues, wikis, releases, patches, and Git-native
collaboration. It does not provide a pull-request system, CI, registries, or project-management UI.

## Installation

Install Node.js 24 LTS, Git, and the native build prerequisites for `better-sqlite3`. Copy
`config.example.yml` to `config.yml`, choose persistent absolute storage paths, set a random
32-byte base64url master key, then run `npm ci`, `npm run build`, and `npm start -- --config
config.yml`. The first account created through the browser becomes the administrator in a
transaction that prevents multiple bootstrap administrators.

## Docker

Run `docker compose up -d`. Persist `/var/lib/bareline`; losing that volume loses application
metadata, repositories, LFS objects, and plugin data. Put Caddy, nginx, or Traefik in front and set
`server.tls.mode: proxy`. Forward the original scheme and address only from a trusted local proxy.

## Creating and cloning a repository

Choose **New repository**, give it a lowercase name, and optionally initialize a README. HTTPS uses
a personal access token in place of a password. SSH requires adding your public key in Git
credentials and installing the generated forced-command lines in OpenSSH.

```sh
git clone git@server:alice/project.git
cd project
git add README.md
git commit -m "Initial commit"
git push -u origin main
```

An SSH key is the public half of a cryptographic identity. Generate one with `ssh-keygen -t ed25519`.
Never upload or copy the private key.

## Importing from another Git host

An administrator can create a Bareline-managed repository from a public Git repository hosted
elsewhere. First allowlist each exact source hostname in deployment configuration and restart:

```yaml
mirrors:
  allowedHosts:
    - github.com
    - gitlab.example.com
  importTimeoutMs: 300000
  maxImportBytes: 10737418240
  maxImportRefs: 10000
```

Open **Administration → Repositories → Import from another Git host**, enter the public HTTPS clone
URL and destination owner/name, then inspect the advertised branches, tags, and default branch.
Confirming the preview clones all Git refs into new managed bare-repository storage. A failed,
cancelled, oversized, or timed-out import leaves no repository record and removes partial storage.

Remote imports reject credentials in URLs, query strings, redirects, non-HTTPS transports,
non-allowlisted hosts, and hosts resolving to private or reserved addresses. This first version is
for public Git repositories; private-source credentials and Git LFS payload migration are not
supported. LFS pointer files remain in Git, but their referenced objects must be migrated separately.
Use a pull mirror after import only when Bareline should continue following the source repository.

## Git basics

A commit is an immutable snapshot with a message and parent. A branch is a movable name pointing to
a commit; a tag is normally a stable release name. `git pull` fetches remote commits and integrates
them. `git push` publishes local refs. Add another server with `git remote add NAME URL`.

Git LFS replaces large working-tree files with small pointer files and stores their payloads in the
local LFS store. Enable LFS in configuration, install `git-lfs`, then use `git lfs track '*.psd'`.

## Backups and restore

Set a 32-byte base64url `security.masterKey` for production, then stop the service and run
`bareline backup --output /safe/backup --config config.yml`. The backup includes an online SQLite
snapshot, configuration, plugins, repositories, trash, and LFS data with checksums and an authenticated
manifest. Run `bareline restore-verify --input /safe/backup --config config.yml`, copy verified backups
off-host, and restore only while stopped with `--confirm-replace`; existing data is first moved to a
recoverable pre-restore directory. Filesystem snapshots must capture SQLite and repository storage
consistently and must not follow untrusted symlinks.

Repository administrators can protect branches, add read-only deploy keys, configure allowlisted
mirrors, and mark repositories as templates under **Repository settings**. Your home page keeps a
small permission-filtered list of pinned and recently viewed repositories. The Activity view shows
Git and repository changes.

## Repository workflows

Repositories include issue tracking, Markdown wikis, tag-backed releases with downloadable assets,
and language/contributor insights. Signed-in users can fork a readable repository; users with write
access can import a reviewed patch, cherry-pick or revert a commit, and merge branches. These are
Git-native workflows, not pull requests. See [Repository workflows](repository-workflows.md) for
permissions, safety boundaries, and the relevant UI paths.

## Standalone distribution

Release bundles contain Node, compiled application files, native SQLite bindings, licenses, and a
launcher. Native dependencies make a single opaque executable less reliable across libc/platform
variants, so platform-specific self-contained bundles are the supported fallback.

## Troubleshooting

Run `bareline config check`, `bareline version`, and `git --version`. Confirm storage is writable by
the non-root service account, the public URL matches the browser origin, and proxy headers cannot be
supplied directly by internet clients. Search status is available with `bareline search status`.
