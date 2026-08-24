# Contributing

Contributions are welcome under AGPL-3.0-only. By contributing, you certify that you have the right to
submit the work under that license and agree to the Developer Certificate of Origin 1.1.

Before opening a change:

```bash
npm install
npm run check
```

Security-sensitive changes must include negative tests. Git integrations must use the central Git
runner with argument arrays and real temporary repositories. HTTP routes must call domain services
instead of reproducing authorization or mutation logic.

Keep core focused on Git hosting and browsing. Issues, CI/CD, pull requests, registries, deployments,
and project-management features belong in plugins, not core.
