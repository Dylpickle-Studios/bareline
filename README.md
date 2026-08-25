# Bareline

> A focused Git server and Git web interface, without project-management or CI clutter.

Bareline is a lightweight, server-rendered home for repositories, files, commits, diffs, branches,
tags, blame, search, cloning, and pushing.

Git-focused collaboration includes protected branches, repository-scoped read-only deploy keys,
scheduled pull/push mirrors, trusted signature identities, repository templates, activity feeds,
pinned/recent repositories, conflict-safe browser editing, and encrypted off-site backup uploads.

This project intentionally does **not** provide issues, pull requests, CI/CD, project boards,
registries, deployments, or DevOps dashboards. Plugins may add independent capabilities, but those
features will not become core abstractions.

## Current development status

Bareline 1.0 is released. Every item on the pre-1.0 acceptance checklist in
[docs/production-readiness.md](docs/production-readiness.md) is complete: validated YAML
configuration, versioned SQLite migrations, Argon2id accounts, secure sessions and CSRF protection,
centralized repository permissions, opaque bare-repository storage, repository browsing,
commits/diffs/refs, Smart HTTP clone/fetch/push plumbing, scoped hashed tokens, an OpenSSH
forced-command boundary, immutable audit records, responsive server-rendered UI, LFS, plugins,
backups, and real-Git integration/security/Playwright/API tests, a non-root Docker image, and a
self-contained standalone bundle.

Semantic versioning applies from 1.0 onward; see [CHANGELOG.md](CHANGELOG.md) for release notes.

## Design preview and container image

The `Deploy design preview` workflow publishes the interactive, seeded interface demo from `demo/` to GitHub
Pages when changes land on `main`. Enable **Settings → Pages → Source: GitHub Actions** once, then
visit `https://OWNER.github.io/REPOSITORY/`. As an alternative, set a `PAGES_ADMIN_TOKEN` Actions
secret with **Pages: write** and **Administration: write** permissions; the workflow will enable the
site on its first run. The standard repository `GITHUB_TOKEN` cannot create a Pages site.

The `Publish container image` workflow publishes `ghcr.io/OWNER/REPOSITORY` from `main` and `v*`
tags. It attaches build provenance and an SBOM. Pull a specific tagged release rather than relying
on `latest` for production deployments.

## Development

Requirements: Node.js 24 LTS, npm 11, Git 2.40 or newer, and a C++ toolchain if a prebuilt SQLite or
Argon2 package is unavailable.

```bash
npm install
cp config.example.yml config.yml
npm run check
npm run dev
```

Open <http://localhost:3000>. The first account is created atomically as the administrator. With the
default closed registration policy, later accounts require an administrator-created invitation.

Generate a one-time personal access token for Git HTTPS during development:

```bash
npm run build
node dist/cli/index.js token create --user alice --write --config config.yml
git clone http://alice:TOKEN@localhost:3000/alice/example.git
```

## Security

Repositories and plugins are hostile input. Git is invoked without a shell, repository paths are
resolved from opaque database records, resource-heavy operations are bounded, and unauthorized
private repositories use non-disclosing responses. See [SECURITY.md](SECURITY.md) and
[docs/threat-model.md](docs/threat-model.md).

## License

Core is licensed under GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). Plugins are
separate works and should declare their own compatible licensing; distribution rules depend on how
they link to and derive from the SDK and core APIs.
