# Getting Started

Bareline is a focused Git server and browser. It provides repositories, history, diffs, search,
SSH and HTTPS transport without issues, pull requests, CI, registries, or project-management UI.

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

## Git basics

A commit is an immutable snapshot with a message and parent. A branch is a movable name pointing to
a commit; a tag is normally a stable release name. `git pull` fetches remote commits and integrates
them. `git push` publishes local refs. Add another server with `git remote add NAME URL`.

Git LFS replaces large working-tree files with small pointer files and stores their payloads in the
local LFS store. Enable LFS in configuration, install `git-lfs`, then use `git lfs track '*.psd'`.

## Backups and restore

Run `bareline backup --output /safe/backup --config config.yml`. The backup includes an online
SQLite snapshot, configuration, plugins, repositories, and LFS data with a checksum manifest.
Verify and copy backups off-host. Restore requires `--confirm-replace`; existing data is first moved
to a recoverable pre-restore directory. Filesystem snapshots must capture SQLite and repository
storage consistently and must not follow untrusted symlinks.

Repository administrators can protect branches, add read-only deploy keys, configure allowlisted
mirrors, and mark repositories as templates under **Repository settings**. Your home page keeps a
small permission-filtered list of pinned and recently viewed repositories. The Activity view shows
Git and repository changes without introducing project-management machinery.

## Standalone distribution

Release bundles contain Node, compiled application files, native SQLite bindings, licenses, and a
launcher. Native dependencies make a single opaque executable less reliable across libc/platform
variants, so platform-specific self-contained bundles are the supported fallback.

## Troubleshooting

Run `bareline config check`, `bareline version`, and `git --version`. Confirm storage is writable by
the non-root service account, the public URL matches the browser origin, and proxy headers cannot be
supplied directly by internet clients. Search status is available with `bareline search status`.
