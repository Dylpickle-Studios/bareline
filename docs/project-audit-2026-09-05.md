# Bareline project audit — 5 September 2026

The original audited working tree contained security and data-recovery defects that should be resolved before production approval. The most urgent are cross-repository LFS disclosure, OIDC login transactions without browser binding, incomplete backups, and outbound connections that do not use the DNS addresses their policy validated.

This is a source and local execution audit of version 1.2.0, including existing tracked and untracked changes. It is not a certification or a penetration test of a deployed instance. No application source was changed during the initial audit. The subsequent remediation is recorded below. Findings distinguish executed reproductions from source-level conclusions; severity reflects the stated prerequisites.

## Remediation

All 15 findings below have been addressed in the working tree. The findings preserve the original
audit evidence and refer to the code before remediation.

| Findings  | Implemented correction                                                                                      | Regression coverage                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1         | Require verified bytes before linking an unlinked LFS object                                                | `audit-collaboration.integration.test.ts`                               |
| 2, 12     | Bind OIDC state to a browser cookie and normalize same-origin return paths                                  | `audit-auth.integration.test.ts`                                        |
| 3, 13     | Back up and restore auxiliary storage; purge it before deleting retry metadata                              | `audit-collaboration.integration.test.ts`, `backup.integration.test.ts` |
| 4         | Pin actual HTTPS/Git connections to validated addresses                                                     | `audit-network.test.ts`, `remote-repository-import.integration.test.ts` |
| 5         | Recheck current archive state at every collaboration mutation                                               | `audit-collaboration.integration.test.ts`                               |
| 6, 7      | Share transport concurrency limits and propagate response backpressure                                      | `audit-streaming.test.ts`, `smart-http.integration.test.ts`             |
| 8, 14, 15 | Fence search job claims, retain new generations, enqueue issue changes, filter access before ranking limits | `audit-search.integration.test.ts`                                      |
| 9         | Send successful Git HTTP ref changes through the shared event publisher                                     | `smart-http.integration.test.ts`                                        |
| 10, 11    | Resolve actual tag refs and enumerate wiki pages from the current tree                                      | `audit-collaboration.integration.test.ts`                               |

See [the upgrade guide](upgrade.md#audit-remediation-upgrade) for backup compatibility and the
OIDC transaction migration.

Remediation validation: the full unit/integration/fuzz suite passed all 198 tests across 79 files;
a subsequently added legacy restore case passed with the six-test collaboration suite, for 199
covered tests in the final tree. Typechecking, linting, build, project formatting, the 431-package
supply-chain policy check, and the critical-flow browser test all passed. The rebuilt release passed
checksum verification and packaged startup, health, backup, restore verification, restore, and
doctor smoke checks. Registry vulnerability
scanning and Docker remain subject to the limitations recorded in the initial audit below.

## Findings

### 1. High — LFS upload negotiation grants access to another repository's objects

Location: [lfs-service.ts](../src/lfs/lfs-service.ts), lines 54–62.

When an object exists anywhere in the global LFS store, an upload batch immediately links it to the requesting repository. It neither checks access to a repository already holding the object nor requires uploading the bytes. Download authorization subsequently trusts this newly created link.

**Executed reproduction:** Uploaded an object to a private repository, created a second account with `none` permission on that repository, and negotiated an upload of the same hash and size to the second account's repository. Download returned the private bytes without a second upload. An attacker needs an object hash and size, for example from an LFS pointer retained after access is revoked; those values must not serve as authorization.

**Fix:** Reuse an existing object without an upload only when the caller is authorized to read it. Otherwise require a verified upload before creating the repository link. Add a two-account HTTP regression test.

### 2. High — OIDC callbacks are not bound to the browser that started login

Locations: [external-auth-service.ts](../src/auth/external-auth-service.ts), lines 31–92; [auth-public.ts](../src/app/routes/auth-public.ts), lines 324–343.

The start route sets no transaction cookie. The callback retrieves the verifier and nonce solely through the URL's state value and then creates a session in whichever browser presents the callback. PKCE, nonce, expiry, and single-use state do not establish browser ownership here.

**Source-confirmed attack path; no live identity-provider test:** An attacker starts an OIDC flow, authenticates as themselves, intercepts the unused callback, and induces a victim to navigate to it. The victim receives the attacker's account session and may unknowingly upload private material into that account. This is login CSRF/session swapping, not direct theft of the victim's existing session. The protocol requires transaction values to be bound to the initiating user agent. See [RFC 9700, section 2.1](https://datatracker.ietf.org/doc/html/rfc9700#section-2.1).

**Fix:** Bind the stored transaction to a random, HttpOnly, Secure, SameSite browser cookie or an equivalent pre-login session; verify the binding before consuming the flow or exchanging the code. Test callback transplantation between two browser contexts.

### 3. High — Backups omit all wiki content and release attachment bytes

Locations: [backup-service.ts](../src/backup/backup-service.ts), lines 124–134 and restore target definitions; [wiki-service.ts](../src/repositories/wiki-service.ts), `path()`; [release-service.ts](../src/repositories/release-service.ts), `assetPath()`.

Backup creation copies repositories, trash, LFS, plugins, and plugin trash. Wikis live under `storage.data/wikis`, and attachments under `storage.data/releases`; neither directory is copied, restored, or required by restore verification. Release metadata survives in SQLite while the referenced files do not. Restoring over existing storage can also leave wiki content from the wrong point in time.

**Executed reproduction:** Created a wiki and release assets, then created a successful backup. Its manifest contained no wiki or release files.

**Fix:** Add both roots to backup overlap checks, snapshots, manifests, restore staging/rollback, and restore verification. Define compatibility for older backups and test recovery into an empty data root with actual wiki history and downloaded attachment bytes.

### 4. High, conditional — DNS validation is disconnected from outbound connections

Locations: [outbound-policy.ts](../src/security/outbound-policy.ts), `assertSafeUrl()` and `assertSafeHostname()`; [webhook-service.ts](../src/webhooks/webhook-service.ts), lines 159–169; Git import, mirror, plugin Git install, and OTLP callers.

The policy resolves a hostname twice, checks those answers, then returns its original URL. `fetch()` and Git independently resolve that hostname when connecting. A public/public/private answer sequence can pass the policy and send the subsequent connection to an address the policy would reject. Resolving twice is not connection pinning.

**Source-confirmed:** Exploitation requires control or compromise of an allowlisted hostname's DNS and a reachable service compatible with the transport; HTTPS certificate validation still applies. No DNS-rebinding attack was run against a network service. The backup upload client already uses a resolved address with the original TLS server name and is not implicated in this particular defect.

**Fix:** Carry approved addresses into the actual connection, preserving TLS hostname validation. Use a validating lookup/dispatcher for HTTP and an equivalent pinned resolution mechanism for Git. Test the address actually connected to, not just the resolver helper's return value.

### 5. Medium — Archived repositories remain writable through collaboration services

Locations: [wiki-service.ts](../src/repositories/wiki-service.ts), `writePage()`/`deletePage()`; [release-service.ts](../src/repositories/release-service.ts), mutation methods; [issue-service.ts](../src/repositories/issue-service.ts), mutation methods; [create-app.ts](../src/app/create-app.ts), `writableRepository()`.

`RepositoryService.require()` checks permission levels, not the archive flag. These services do not add an archive check. Git mutations and LFS routes do check it, leaving inconsistent enforcement of the documented read-only state.

**Executed reproduction:** Set `archived_at`, fetched a fresh repository record, and successfully wrote a wiki page and uploaded a release attachment. Issue mutation paths have the same omission by source inspection.

**Fix:** Introduce and reuse an explicit content-mutation guard. Apply it to issues, comments, labels, wiki pages, releases, and assets while preserving administrative unarchive operations. Test each write surface against a freshly archived repository.

### 6. Medium — Archive generation bypasses process concurrency limits

Location: [archive-service.ts](../src/git/archive-service.ts), lines 17–42.

After short GitRunner calls resolve the commit and path, archive creation spawns Git directly without either the runner's limiter or `gitTransportLimiter`. Public archive requests can therefore keep launching processes while previous streams remain active. Byte limits and a minimum 120-second timeout do not cap aggregate process, CPU, or compression memory use.

**Source-confirmed; no load attack performed.**

**Fix:** Acquire a bounded shared permit for the complete archive-stream lifetime and release it on all exit, disconnect, and error paths. Test overlapping slow downloads against the configured cap.

### 7. Medium — Smart HTTP ignores response backpressure

Location: [smart-http.ts](../src/http-git/smart-http.ts), lines 108–110 and 131–133.

Git stdout is read in flowing mode and every chunk is written to the HTTP response without checking the return value of `write()`. A slow client can cause most of a pack to accumulate in server memory. The default per-transfer limit is 1 GiB, so the transport concurrency cap still permits a large aggregate memory footprint.

**Source-confirmed; no memory-exhaustion test performed.**

**Fix:** Pause stdout when the response returns false and resume on `drain`, or use a pipeline after bounded CGI-header parsing. Verify memory remains bounded with a deliberately slow response sink.

### 8. Medium — Search work enqueued during indexing can be lost

Location: [search-service.ts](../src/search/search-service.ts), lines 44–55 and 83–86.

Enqueue resets an existing running row to pending. The older worker then deletes that same row by ID after its awaited rebuild completes. A push arriving after that rebuild captured its Git snapshot may never be indexed until another event occurs.

**Executed deterministic reproduction:** Paused a rebuild, enqueued the same repository again, observed one pending job, then completed the old rebuild. Pending jobs fell to zero.

**Fix:** Use a generation/claim token and condition completion on it, or maintain separate running and pending generations. Test enqueue-during-rebuild and overlapping workers.

### 9. Medium — Ordinary Git HTTP pushes do not publish webhook deliveries

Locations: [git.ts](../src/app/routes/git.ts), lines 158–166; [create-app.ts](../src/app/create-app.ts), `publishRepositoryEvent()`.

The HTTP receive path calls `pluginEvents.publish()` directly. The shared publisher that sends to both plugins and webhooks is not used here. A webhook accepting `repository.pushed` can be created, but this push path never queues its delivery.

**Source-confirmed:** The route records activity and enqueues search, so the omission is specifically webhook dispatch.

**Fix:** Expose and use the shared repository-event publisher for Git transport completion, with explicit handling of rejected receives. Add a real push test that checks the webhook delivery queue.

### 10. Medium — A release can be created without its claimed tag

Location: [release-service.ts](../src/repositories/release-service.ts), lines 97–107.

Creation resolves the supplied tag name as an arbitrary Git revision. An existing branch such as `main` succeeds, so tag creation is skipped. The database then stores a supposedly tag-backed release for which `refs/tags/main` does not exist.

**Executed reproduction:** Creating a release named `main` succeeded while `git tag --list` remained empty.

**Fix:** Validate a tag name and resolve `refs/tags/<name>` explicitly. Create that tag if absent; avoid treating unrelated Git errors as evidence that a tag is missing. Test branch/tag name collisions.

### 11. Medium — Wiki listings retain deleted pages and stale update metadata

Location: [wiki-service.ts](../src/repositories/wiki-service.ts), lines 100–120.

The page list is built from the history of file additions (`git log --diff-filter=A`), not the current tree. Deletes never remove entries, and subsequent edits do not update the displayed timestamp or subject. Every list request also walks the addition history rather than a bounded current inventory.

**Executed reproduction:** Updating `Home` left its subject as `initial`; deleting it still left `Home` in `listPages()`.

**Fix:** Enumerate existing Markdown pages at HEAD and obtain the latest relevant metadata for those pages. Test listing after edits, deletion, and recreation.

### 12. Medium — OIDC return-path validation permits external redirects

Location: [external-auth-service.ts](../src/auth/external-auth-service.ts), line 39; [auth-public.ts](../src/app/routes/auth-public.ts), line 343.

The regular expression rejects a second forward slash but permits a backslash. A return path consisting of `/`, then `\`, then `attacker.example` passes validation; URL parsing resolves it to `https://attacker.example`. After successful OIDC login the value is sent as the redirect destination.

**Executed validation reproduction:** The exact expression returned true and `new URL(value, 'https://bareline.example').origin` returned `https://attacker.example`. No live OIDC flow was used.

**Fix:** Parse against the public URL, require an identical origin, reject control characters/backslashes, and return only the normalized local path/query/fragment. Add encoded and literal backslash cases.

### 13. Medium — Repository purge leaves wiki and release files behind

Location: [repository-admin-service.ts](../src/repositories/repository-admin-service.ts), lines 348–389.

The purge deletes the main Git directory and repository database row. Cascading foreign keys remove release asset metadata, but there is no filesystem cleanup for the corresponding attachment storage keys or wiki directory. Sensitive data survives the configured repository trash-retention period, and attachment paths become orphaned after their identifying rows are deleted.

**Source-confirmed:** Neither auxiliary root is referenced by repository deletion/purge.

**Fix:** Integrate auxiliary data into the repository trash lifecycle. Retain attachment storage keys until cleanup succeeds and make retries safe. Test that expiration removes all repository-owned filesystem data without deleting shared LFS objects still in use.

### 14. Medium — Issue API changes do not schedule search indexing

Locations: [api-repository-issues.ts](../src/app/routes/api-repository-issues.ts), create/update handlers; [issue-service.ts](../src/repositories/issue-service.ts), mutation methods.

HTML issue creation explicitly calls `search.enqueue()`. The equivalent API handlers do not, and neither the issue service nor its configured event publisher schedules indexing. Issues created through the API can stay absent from search, and edited titles/bodies can remain stale until an unrelated repository event or manual rebuild.

**Source-confirmed:** The issue search integration test manually enqueues a job, so it does not exercise automatic API-to-index propagation.

**Fix:** Schedule indexing centrally after searchable issue changes, covering both HTML and API entry points. Test API creation/edit followed by the ordinary worker loop without a manual enqueue.

### 15. Medium — Inaccessible search hits can hide accessible results

Location: [search-service.ts](../src/search/search-service.ts), `search()`, SQL `ORDER BY ... LIMIT` followed by the permission loop.

The query selects at most 200 globally ranked documents before checking repository access. If those candidates belong to inaccessible repositories, an authorized match ranked below them is never considered. This can produce an empty search result even when a matching public document exists. It also contradicts the threat model's claim that filtering occurs before ranking. The returned excerpts are permission-checked, so this finding does not assert direct private-content disclosure.

**Source-confirmed.**

**Fix:** Apply accessible-repository filtering inside the candidate query, or use bounded, correctly paginated candidate retrieval until enough authorized results are found. Test many high-ranking private matches ahead of one accessible match.

## Initial audit validation and coverage

Reviewed application initialization and route authorization, authentication and credentials, Git HTTP/SSH and subprocess controls, repository/collaboration services, SQLite migrations, search jobs, LFS, plugin installation/sandbox boundaries, outbound policy, backups, rendering, observability, Docker/release scripts, CI, and security documentation. Review depth was greatest at security boundaries and new collaboration features; not every UI style or generated asset was examined line by line.

| Check                         | Result                                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / Git                    | Node 24.19.0; Git 2.47.3                                                                                                                                                                                                   |
| `npm run typecheck`           | Passed                                                                                                                                                                                                                     |
| `npm run lint`                | Passed                                                                                                                                                                                                                     |
| `npm run build`               | Passed                                                                                                                                                                                                                     |
| `npm run format:check`        | Passed for the project; audit document separately formatted after final edits                                                                                                                                              |
| `npm run supply-chain:check`  | Passed; 431 locked packages                                                                                                                                                                                                |
| Unit/integration/fuzz suite   | Passed: 74 files, 183 tests, using `LOG_LEVEL=silent npm test -- --maxWorkers=2`; 239.36 seconds                                                                                                                           |
| Browser suite                 | Passed: one critical-flow browser test with `--timeout=120000`; 56.4 seconds. Initial 30-second run timed out during browser page setup.                                                                                   |
| Dependency vulnerability scan | Not completed: initial registry DNS failure; expanded-network attempt rejected by automatic approval review because it exports dependency metadata. User approval requested. This is not evidence of zero vulnerabilities. |
| Docker smoke test             | Not run: Docker socket access denied even outside the sandbox                                                                                                                                                              |
| Release bundle/smoke          | Passed: built 1.2.0 bundle, verified checksums, and passed bundled startup, health, backup, restore verification, restore, and doctor smoke.                                                                               |

Initial broad test attempts were interrupted after sandbox failures and resource-related timeouts. They are not counted as clean results. Temporary reproductions used isolated databases/repositories under `/tmp` and removed their fixture data. Reproduction scripts and logs are available locally as `/tmp/bareline-audit-repro.mts`, `/tmp/bareline-audit-repro.log`, `/tmp/bareline-audit-search.mts`, and `/tmp/bareline-audit-search.log`.

Existing controls worth retaining include opaque repository storage identifiers, prepared SQL, non-disclosing repository permission checks, scoped token enforcement, Argon2 password hashes, hashed session/token values, CSRF checks on browser mutations, sanitized Markdown, restrictive CSP, bounded GitRunner operations, plugin permission grants, worker-process WebAssembly isolation, and transactional backup restore staging. These controls do not cover the gaps above.

The initial audit recommended prioritizing findings 1–4, then unify archive/lifecycle enforcement and repairing resource controls, and adding regression tests that cross service boundaries: two users and two repositories, browser-to-browser OIDC callback transfer, backup-to-empty-root restore, real Git push-to-webhook delivery, and concurrent queue updates. The existing tests mostly exercise individual happy paths for the newly added collaboration storage.
