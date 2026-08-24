# REST API

## Authentication

The API is versioned under `/api/v1`. Send `Authorization: Bearer TOKEN`. Repository endpoints use
`repository:read` or `repository:write`; account and group endpoints use `api:read` or `api:write`.
Create the narrowest token that works, set an expiration, and revoke it when automation is retired.
Raw tokens are displayed once and stored only as digests.

## Pagination and errors

Collections accept bounded page/per-page inputs where applicable and return a `pagination` object.
Errors have one stable shape:

```json
{ "error": { "code": "not_found", "message": "…", "requestId": "req-123" } }
```

Private resources deliberately use non-disclosing errors. A client must not infer that a private
name exists from autocomplete, search, timing, or error text. Respect `429` responses and retry with
backoff.

## Repositories, refs, and files

The API lists and creates repositories, reads trees, bounded base64 blobs, per-file history, blame,
commits, and comparisons, manages collaborators and settings, creates/deletes branches and tags,
and creates web commits. File writes require base64 content, a branch, and a commit message. Repository deletion
requires the exact `owner/repository` confirmation query and uses delayed trash semantics.
Repository updates can also transfer ownership to a group the caller owns.

Repository subresources expose activity, branch policies, deploy keys, mirror configuration, and
pin state. These routes call the same enhancement service as HTML settings and therefore retain the
same repository permission checks and audit behavior. Deploy-key material is returned only to
repository administrators; private activity remains subject to repository read authorization.

## Users, groups, and administration

User responses omit credentials and hidden email. Group responses are limited to members and expose
member roles only to group members. Managers may change members; only owners may grant ownership.
Administrative endpoints require both an administrator account and an explicit administrative token
scope.

`/api/v1/user/tokens`, `/api/v1/user/ssh-keys`, and `/api/v1/user/passkeys` expose the same scoped credential lifecycle as
the account UI. Newly created token secrets appear in exactly one response and never in collection
responses. Profile, appearance, and session endpoints share the account services used by the HTML
UI. User-to-user repository transfers require explicit acceptance through the pending-transfer
endpoints. Administrator endpoints cover users, repositories, audit events, invites, plugins,
plugin permissions and schema-driven plugin settings, runtime settings, and search-index
inspection/rebuild. `/api/v1/search` returns
permission-filtered repository, file, commit, branch, tag, user/group-directory, and documentation
results. Anonymous search returns public repository and documentation results only.

## OpenAPI

Interactive documentation is served at `/api/docs`; the generated OpenAPI document is the contract
for paths, parameters, request bodies, response objects, bearer or session-cookie security, and
error shapes. Every core `/api/v1` operation has a bounded, closed request/response schema; plugin
endpoints retain plugin-defined response bodies. Generate clients from that document rather than
scraping HTML routes.
