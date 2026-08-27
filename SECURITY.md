# Security Policy

## Supported versions

The latest minor release line receives security fixes. Older release lines are not backported unless
the release record says otherwise; upgrade to the latest release before reporting whether an issue is
still present.

| Release line      | Security support                                      |
| ----------------- | ----------------------------------------------------- |
| `1.1.x`           | Supported                                             |
| `1.0.x` and older | Upgrade required; no backport commitment              |
| `main`            | Development line; not a production support commitment |

## Reporting vulnerabilities

Do not open a public issue for a suspected vulnerability. Use the private
[GitHub Security Advisory report form](https://github.com/Dylpickle-Studios/bareline/security/advisories/new).
If that form is unavailable, contact the project owner privately and do not send secrets or details
through a public issue or discussion. Include the affected version or commit, deployment context,
reproduction, impact, and proposed mitigation. Remove credentials and private repository data from
the report; attach a minimal proof of concept only when necessary.

Maintainers will acknowledge a complete report within three business days, provide an update at
least every seven days while triaging, and coordinate a fix, credit, and disclosure date with the
reporter. Emergency active exploitation may require an accelerated disclosure. Do not publish an
advisory or proof of concept until the maintainer confirms that affected users have a mitigation.

Never include production credentials, private repository contents, or personal data in a report.

## Trust model

- Repository names, refs, Git objects, Markdown, images, archives, and Git configuration are hostile.
- Registered SSH keys authenticate only the forced Git commands documented by the application.
- Personal access tokens are bearer credentials and must be protected like passwords.
- Trusted Node plugins are equivalent to installing server software. A malicious trusted plugin can
  compromise the host regardless of application-level permission declarations.
- Sandboxed plugins use a separate WebAssembly worker and explicit host capabilities. Sandbox escape
  reports are treated as critical vulnerabilities.
- The server does not execute repository hooks, filters, textconv commands, or repository binaries.

See the detailed [threat model](docs/threat-model.md).
