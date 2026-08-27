# Threat Model

## Assets and boundaries

The primary assets are private Git content, account credentials, sessions/tokens, signing identities,
repository integrity, plugin data, and host filesystem integrity. Boundaries exist at HTTP, OpenSSH,
Git subprocesses, SQLite, imported roots, archive/upload parsing, and plugin runtimes.

## Principal threats and controls

- **Traversal and symlinks:** logical names never form storage paths; canonical paths must remain
  inside an allowed root; repository-internal paths use POSIX normalization and object lookup.
- **Command and option injection:** Git and SSH commands use `spawn` with argument arrays; refs reject
  option-like values and are resolved after `--end-of-options`; forced SSH commands match one strict
  grammar.
- **Hostile Git configuration:** system/global configuration, hooks, external diffs, attributes,
  prompts, and protocol-from-user behavior are disabled for rendering operations.
- **Authorization bypass and metadata leaks:** capability checks are centralized; private repository
  discovery uses non-disclosing errors; search and palette providers filter before ranking.
- **XSS:** templates escape by default; repository Markdown uses an explicit sanitizer allowlist;
  active SVG and plugin HTML are isolated or downloaded rather than embedded.
- **CSRF/session attacks:** mutations require synchronizer tokens; opaque sessions are hashed, rotated,
  revocable, expiring, HttpOnly, SameSite, and Secure under HTTPS.
- **Credential leakage:** passwords use Argon2id; bearer tokens are shown once and stored as digests;
  structured logs redact credential fields.
- **Resource exhaustion:** Git operations, bodies, blobs, diffs, archives, images, search, and plugin
  calls have independent time/byte/count/concurrency limits.
- **Malicious plugins:** trusted plugins carry an explicit host-compromise warning. Sandboxed plugins
  run as capability-limited WebAssembly in a separate disposable worker with no ambient host access.
- **Unsafe deletion/races:** hosted repositories move atomically to delayed trash; mutations use
  database transactions and compare-and-swap reference updates.
- **Mirrors and SSRF:** mirror, plugin, OIDC/LDAP, and backup URLs use HTTPS where applicable,
  reject embedded credentials and redirects, require explicit host policy, resolve at connection
  time, reject DNS rebinding and private/loopback/link-local/metadata/multicast/reserved addresses,
  and remain subject to deployment egress controls.
- **Branch-policy bypass:** web commits enforce matching policies before object creation. Git
  receive rejects force pushes/deletions conservatively and refuses transport pushes when an
  advanced policy cannot be proven without executable hooks.
- **Off-site backups:** destination credentials use authenticated encryption and uploads use bounded
  SigV4 over HTTPS. Manifests can be HMAC-authenticated with `security.masterKey`; optional archive
  encryption uses AES-256-GCM with a separate environment key. Restore stages and rolls back target
  swaps where possible.

Residual risks include vulnerabilities in Git, SQLite/native addons, the WebAssembly engine, image
decoders, and administrators deliberately enabling trusted code. Dependencies, base images, and
GitHub Actions still require continuous updates and immutable deployment pinning. No independent
security audit is represented by this repository's tests.

The executable coverage mapping is maintained in [Security Test Matrix](security-test-matrix.md).
