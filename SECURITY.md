# Security Policy

## Supported versions

Until 1.0, only the current main development line receives security fixes. After 1.0, the latest
minor release and the previous minor release will receive coordinated security updates.

## Reporting vulnerabilities

Do not open a public issue for a suspected vulnerability. Send a private report to the security
contact configured in the eventual project metadata. Include the affected version, reproduction,
impact, and any proposed mitigation. Maintainers will acknowledge complete reports within three
business days and coordinate disclosure after a fix is available.

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
