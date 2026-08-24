# Security Test Matrix

Every boundary in the threat model has an executable regression test. This matrix is reviewed when
the threat model changes.

Repository-enhancement coverage includes policy enforcement, receive configuration, activity and
private discovery state, strict deploy-key authorization, mirror allowlists, authenticated backup
encryption, shared API authorization, and OpenAPI exposure.

| Threat-model control                    | Regression coverage                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Traversal and symlinks                  | `validation.test.ts`, `repository-import.integration.test.ts`                                                           |
| Command and option injection            | `validation.test.ts`, `ssh.test.ts`, `repository.integration.test.ts`                                                   |
| Hostile Git configuration and hooks     | `git-runner-limits.test.ts`, `repository.integration.test.ts`                                                           |
| Authorization bypass and metadata leaks | `api.integration.test.ts`, `search.integration.test.ts`, `security-regression.integration.test.ts`                      |
| XSS and active repository content       | `markdown.test.ts`, `image-metadata.test.ts`, `gitmodules.test.ts`                                                      |
| CSRF and session attacks                | `auth.test.ts`, `credential-lifecycle.integration.test.ts`, `security-regression.integration.test.ts`                   |
| Credential leakage                      | `token.test.ts`, `recovery.test.ts`, `secret-box.test.ts`, `security-regression.integration.test.ts`                    |
| Resource exhaustion                     | `git-runner-limits.test.ts`, `diff-parser.test.ts`, `image-metadata.test.ts`, `lfs.integration.test.ts`                 |
| Malicious plugins                       | `plugin-manager.integration.test.ts`, `plugin-contributions.integration.test.ts`, `sandbox-runtime.integration.test.ts` |
| Unsafe deletion and races               | `groups-repository-admin.integration.test.ts`, `web-commit.integration.test.ts`, `auth.test.ts`                         |
