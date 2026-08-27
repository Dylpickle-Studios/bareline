# Security Policy

## Supported versions

Until a supported-release policy is published, only the current main development line is supported
for security fixes. Do not infer a production support commitment from the package version.

## Reporting vulnerabilities

Do not open a public issue for a suspected vulnerability. The project owner must configure and test
a private security channel before production exposure. Until that channel is published, contact the
project owner through the private channel designated for this deployment; do not send secrets or
details through a public issue or discussion. Include the affected version, reproduction, impact,
and proposed mitigation. Response and disclosure timelines are agreed case by case.

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
