# Bareline

> A focused Git server and Git web interface, without project-management or CI clutter.

Bareline is a lightweight, server-rendered home for repositories, files, commits, diffs, branches,
tags, blame, search, cloning, and pushing. The temporary product name and links are centralized so a
future name can be adopted without touching routes or templates.

This project intentionally does **not** provide issues, pull requests, CI/CD, project boards,
registries, deployments, or DevOps dashboards. Plugins may add independent capabilities, but those
features will not become core abstractions.

## Current development status

The application is under active development toward its first production release. The implemented
foundation includes validated YAML configuration, versioned SQLite migrations, Argon2id accounts,
secure sessions and CSRF protection, centralized repository permissions, opaque bare-repository
storage, repository browsing, commits/diffs/refs, Smart HTTP clone/fetch/push plumbing, scoped hashed
tokens, an OpenSSH forced-command boundary, immutable audit records, responsive server-rendered UI,
and real-Git integration tests.

Do not treat the current pre-1.0 tree as production-ready until the release checklist is complete.
The live acceptance checklist is maintained in
[docs/production-readiness.md](docs/production-readiness.md); unchecked required items are active
work, not deferred aspirations.

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
