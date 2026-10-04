# Bareline project audit — 2 October 2026

This is a source, local-execution, and user-experience audit of the 1.2.0 development tree
(commit `cc6051a`). It follows the [5 September 2026 audit](project-audit-2026-09-05.md) and
focuses on three questions: does the Git transport behave correctly with real clients, is the
application as lightweight as its positioning claims, and where does the server-rendered
interface get in the user's way. Every finding below was fixed in the same change set; the
regression coverage column names the test that now guards each one.

Baseline before changes: `npm run typecheck`, `npm run lint`, `npm run format:check`, and the
full Vitest suite (79 files, 199 tests) all passed. The repository's `.git` directory was
missing its `HEAD`, `config`, and index files, which made Git report "not a git repository"; those
were restored so the audit could be diffed against `main`. No application source was changed
before the findings were recorded.

## Findings

| #   | Severity | Area           | Finding                                                                                                                                                                                                                                                                                                   | Correction                                                                                                                            | Regression coverage                                          |
| --- | -------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | High     | Git Smart HTTP | `Content-Encoding: gzip` request bodies were handed to `git http-backend` undeclared. Git compresses upload-pack negotiation bodies over 1 KiB, so fetches of repositories with more than a few refs, or from clones with local history, failed mid-transfer (reproduced: the connection was terminated). | Forward the encoding as `HTTP_CONTENT_ENCODING`; reject encodings other than identity/gzip with 415.                                  | `smart-http.integration.test.ts`                             |
| 2   | Medium   | Git Smart HTTP | The client's `Git-Protocol` header was dropped, so every HTTP clone and fetch negotiated with wire protocol v0 even when both sides supported v2 (full ref advertisement on every request).                                                                                                               | Forward the header as `HTTP_GIT_PROTOCOL` after validating its characters.                                                            | `smart-http.integration.test.ts`                             |
| 3   | High     | Git LFS        | The batch endpoint only parsed `application/json`. The `git-lfs` client sends `application/vnd.git-lfs+json`, which Fastify rejected with 415 and the error handler turned into a 500 HTML page (reproduced). LFS was therefore unusable with the real client.                                            | Register a bounded JSON parser for the LFS media type and return JSON error documents on LFS routes; map 415.                         | `lfs.integration.test.ts`                                    |
| 4   | Medium   | Performance    | Every repository page that renders a branch/tag picker called `GitBrowser.tags()`, which ran `git verify-tag` for up to 50 signed tags on each request, in addition to the picker's own `for-each-ref` calls.                                                                                             | Signature verification is now opt-in and requested only by the Tags page.                                                             | `navigation-ux.integration.test.ts`                          |
| 5   | Low      | Performance    | `.gitmodules` was read (three Git subprocesses) on every directory and landing page even when the listing contained no submodule entry.                                                                                                                                                                   | Read it only when a `commit` entry is present.                                                                                        | `web-browsing.integration.test.ts`                           |
| 6   | Low      | Performance    | The hosted storage root was `realpath`-resolved on every `storagePath()` call, several times per request.                                                                                                                                                                                                 | Resolve once per process and reuse.                                                                                                   | existing repository suites                                   |
| 7   | Low      | Operations     | The global rate limit counted the stylesheet, script, and logo loaded by every page, consuming a third of the per-minute budget before any dynamic request.                                                                                                                                               | Static assets under `/assets/` are exempt.                                                                                            | manual                                                       |
| 8   | Low      | Operations     | Production asset caching was limited to one hour because asset URLs carried no version; after an upgrade browsers could still hold stale CSS/JS for that hour.                                                                                                                                            | Asset URLs now carry `?v=<version>`; production responses are immutable for one year.                                                 | `navigation-ux.integration.test.ts`                          |
| 9   | Low      | Operations     | Every 401/403/404 was logged at `error` level with a stack trace, burying genuine failures.                                                                                                                                                                                                               | Client-side rejections log at `warn` with status and reason only; 5xx keep the stack.                                                 | manual                                                       |
| 10  | Low      | Build          | There was no `.dockerignore`, so `docker build` uploaded `node_modules`, `.git`, test output, and local data as build context.                                                                                                                                                                            | Added `.dockerignore`.                                                                                                                | manual                                                       |
| 11  | Low      | Interface      | The command palette listed an entry titled "Plugin runtime.documentation" (a leftover from an automated refactor).                                                                                                                                                                                        | Renamed to "Plugin documentation".                                                                                                    | `navigation-ux.integration.test.ts`                          |
| 12  | Medium   | Interface      | Commit history and file history accepted a `page` parameter but rendered no way to reach another page; history beyond 30 commits was unreachable from the interface.                                                                                                                                      | Older/Newer controls driven by a `hasNext` probe (one extra commit per query).                                                        | `navigation-ux.integration.test.ts`                          |
| 13  | Medium   | Interface      | Only the repository landing page had the Code/Commits/Branches… tab bar; every other repository page offered a single "back" link, so moving between areas meant returning to the landing page first.                                                                                                     | The layout renders one shared tab bar (with the active tab, plugin tabs, and Settings when permitted) on every repository page.       | `navigation-ux.integration.test.ts`, `route-helpers.test.ts` |
| 14  | Low      | Interface      | Relative links and images in READMEs and Markdown files resolved against the page URL and broke.                                                                                                                                                                                                          | Rewrite relative targets to `blob`/`raw` URLs at the viewed ref; absolute, fragment, and scheme links are untouched.                  | `markdown.test.ts`, `navigation-ux.integration.test.ts`      |
| 15  | Low      | Interface      | Explore listed at most 100 repositories with no filter or paging; the signed-in home page showed only pinned and recent items, so a new user saw a marketing hero and nothing else.                                                                                                                       | Explore gains a name/description filter and paging; the home page lists owned, pinned, and recent repositories.                       | `navigation-ux.integration.test.ts`                          |
| 16  | Low      | Interface      | File sizes were raw byte counts; directory views had no parent link; pages had no `<title>` beyond the product name; the palette hint always showed ⌘K and results could not be navigated by keyboard; the reference picker needed a separate Switch click.                                               | Human-readable sizes and line counts, a `..` entry, default titles, platform-aware hint, arrow-key navigation, auto-submit on change. | `navigation-ux.integration.test.ts`, `route-helpers.test.ts` |

Severity reflects impact on a deployed instance: High findings break a documented feature for
real clients; Medium findings degrade performance or make documented content unreachable; Low
findings are operational or usability friction.

## Not changed, by design

- The Content Security Policy keeps `img-src 'self' data:`, so remote images in Markdown are
  still blocked by the browser. This is a deliberate privacy choice (no third-party fetches
  triggered by repository content) and is now documented here rather than changed.
- Swagger UI adds about 2.6 MB to the runtime image and is registered unconditionally at
  `/api/docs`. It serves pre-built static files and costs no request-time work, so it was left in
  place; an operator who wants a smaller image can remove `@fastify/swagger-ui` and its
  registration in `create-app.ts`.
- The built-in syntax highlighter is deliberately small (keywords and comments for a few
  languages) instead of a multi-megabyte grammar bundle. This keeps the front end at roughly 30 KB
  of CSS and 19 KB of JavaScript with no third-party client code.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`: pass.
- `npm test`: 81 files, 207 tests, all passing, including the new suites named above.
- `npm run test:e2e` (Playwright, Chromium): the critical-flows browser scenario passes.
- `npm run smoke:docker` was not run: the Docker daemon is not accessible to the audit account on
  this machine. The Dockerfile itself is unchanged; only `.dockerignore` was added.
- Live reproduction before and after the fix for findings 1 and 3 using `fetch` against a listening
  instance: gzip-encoded `git-upload-pack` requests previously terminated the connection and now
  return a packfile; `application/vnd.git-lfs+json` batch requests previously returned a 500 HTML
  page and now return the batch response.
