# Bareline

> A focused Git server and Git web interface, without pull-request or CI clutter.

Bareline is a lightweight, server-rendered home for repositories, files, commits, diffs, branches,
tags, blame, search, cloning, and pushing.

Git-focused collaboration includes protected branches, repository-scoped read-only deploy keys,
allowlisted public HTTPS repository imports, scheduled pull/push mirrors, trusted signature
identities, repository templates, activity feeds, pinned/recent repositories, conflict-safe browser
editing, and encrypted off-site backup uploads.
It also includes repository issues, wikis, tag-backed releases, patches, forks, branch operations,
and lightweight repository insights. See [the repository workflows guide](docs/repository-workflows.md).

Bareline intentionally does **not** provide pull requests, CI/CD, project boards, registries,
deployments, or DevOps dashboards. Its collaboration tools stay Git- and repository-centred rather
than becoming a general project-management system. Plugins may add independent capabilities.

## Current development status

Bareline is under active development. The core server and its security hardening are covered by
automated unit, integration, fuzz, and release-smoke checks. Production approval still requires the
external controls listed in [docs/production-readiness.md](docs/production-readiness.md), especially
an independent security audit, deployment egress policy, representative backup/restore drill, and
immutable artifact verification.

Semantic versioning applies from 1.0 onward; see [CHANGELOG.md](CHANGELOG.md) for release notes.

## Design preview and container image

The `Deploy design preview` workflow publishes the interactive, seeded interface demo from `demo/` to GitHub
Pages when changes land on `main`. Enable **Settings → Pages → Source: GitHub Actions** once, then
visit `https://OWNER.github.io/REPOSITORY/`. As an alternative, set a `PAGES_ADMIN_TOKEN` Actions
secret with **Pages: write** and **Administration: write** permissions; the workflow will enable the
site on its first run. The standard repository `GITHUB_TOKEN` cannot create a Pages site.

The `Publish container image` workflow publishes `ghcr.io/OWNER/REPOSITORY` from `main` and `v*`
tags. It attaches build provenance, an SBOM, and a signature. Verify the immutable image digest and
those attestations before production deployment; tags and `latest` are not deployment identifiers.

## Development

Requirements: Node.js 24 LTS, npm 11, Git 2.40 or newer, and a C++ toolchain if a prebuilt SQLite or
Argon2 package is unavailable.

```bash
npm ci --ignore-scripts
npm run supply-chain:check
npm run rebuild:native
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
private repositories use non-disclosing responses. See [SECURITY.md](SECURITY.md),
[docs/threat-model.md](docs/threat-model.md), and [docs/security-assurance.md](docs/security-assurance.md).

## License

Core is licensed under GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). Plugins are
separate works and should declare their own compatible licensing; distribution rules depend on how
they link to and derive from the SDK and core APIs.
