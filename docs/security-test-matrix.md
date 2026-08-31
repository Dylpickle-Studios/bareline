# Security Test Matrix

This matrix maps the implemented regression coverage to the threat model. It is reviewed when the
threat model changes; external deployment controls and independent audit evidence are tracked in
[security assurance](security-assurance.md).

Repository-enhancement coverage includes policy enforcement, receive configuration, archival write
guards, health reporting, activity and
private discovery state, strict deploy-key authorization, mirror allowlists, authenticated backup
encryption, shared API authorization, and OpenAPI exposure.

| Threat-model control                        | Regression coverage                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Traversal and symlinks                      | `validation.test.ts`, `repository-import.integration.test.ts`                                                                     |
| Command and option injection                | `validation.test.ts`, `ssh.test.ts`, `repository.integration.test.ts`                                                             |
| Hostile Git configuration and hooks         | `git-runner-limits.test.ts`, `repository.integration.test.ts`                                                                     |
| DNS-aware SSRF and proxy allowlists         | `outbound-policy.test.ts`, `backup-destination.test.ts`, `ip-policy.test.ts`, mirror/plugin integration coverage                  |
| Strict configuration and secret shape       | `config-hardening.test.ts`                                                                                                        |
| Authorization bypass and metadata leaks     | `api.integration.test.ts`, `search.integration.test.ts`, `security-regression.integration.test.ts`                                |
| XSS and active repository content           | `markdown.test.ts`, `image-metadata.test.ts`, `gitmodules.test.ts`                                                                |
| CSRF and session attacks                    | `auth.test.ts`, `credential-lifecycle.integration.test.ts`, `security-regression.integration.test.ts`                             |
| Credential leakage                          | `token.test.ts`, `recovery.test.ts`, `secret-box.test.ts`, `security-regression.integration.test.ts`                              |
| Resource exhaustion                         | `git-runner-limits.test.ts`, `process-limits.test.ts`, `diff-parser.test.ts`, `image-metadata.test.ts`, `lfs.integration.test.ts` |
| Malicious plugins and package integrity     | `plugin-manager.integration.test.ts`, `plugin-contributions.integration.test.ts`, `sandbox-runtime.integration.test.ts`           |
| Backup integrity and recoverable restore    | `backup.integration.test.ts`, `backup-destination.test.ts`                                                                        |
| Parser robustness                           | `tests/fuzz/property-fuzz.test.ts`, nightly `fuzz-nightly.yml`                                                                    |
| Metrics and readiness boundaries            | `health.integration.test.ts`, `metrics.test.ts`                                                                                   |
| Audit integrity checkpoints                 | `audit-service.test.ts`                                                                                                           |
| Backup policy, retention, and restore drill | `backup-policy.test.ts`, `backup.integration.test.ts`                                                                             |
| Webhook secret and queue boundaries         | `webhook-service.test.ts`, `outbound-policy.test.ts`                                                                              |
| Unsafe deletion and races                   | `groups-repository-admin.integration.test.ts`, `web-commit.integration.test.ts`, `auth.test.ts`                                   |
| Request-ID trust boundary                   | `errors.integration.test.ts`; generated IDs are returned while supplied IDs are ignored                                           |
| Static analysis and release verification    | CodeQL workflow; `release:verify`; signed archive/SBOM and image-attestation checks in release workflows                          |

Supply-chain policy is checked by `scripts/verify-supply-chain.mjs` in CI; it is not a substitute
for reviewing advisories, pinning deployment artifacts, or an independent audit.
