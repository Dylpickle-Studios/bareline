# Plugins

The plugin API is versioned independently from the application. Manifest `apiVersion: 1` pairs
with the TypeScript definitions in `src/plugin-sdk`. Plugins must declare every requested
capability; installation grants none automatically. Updates requesting additional permissions are
disabled until an administrator reviews the difference.

## Quick start

Copy the downloadable Repository Word Count example, edit `plugin.yml`, and validate it with:

```sh
bareline plugins validate ./my-plugin --config config.yml
```

Install it from Administration → Plugins. Trusted JavaScript executes with the authority of the
server account and cannot be made safe by application permission checks. Only enable trusted code
after reviewing its source and supply chain.

Sandboxed packages use a `.wasm` entry point. The runtime starts a disposable memory-limited Node
process with deny-by-default process permissions, grants that loader read access only to its own
worker and the validated module, rejects every ambient WebAssembly import, and bounds execution
time and message size. This is defense in depth around the WebAssembly boundary rather than a claim
that the Node permission model alone contains arbitrary JavaScript. Plugins receive no JavaScript
execution surface.

The structured ABI includes only granted capability names, bounded contribution context, and—when
`storage.plugin` is granted—a base64 snapshot of the plugin's namespaced storage. A plugin may return
the versioned `gitHost.effects` envelope defined by the SDK to set or delete bounded storage values.
Every effect is validated and committed by core after the worker exits; denied capabilities fail
closed. Repository data needed by a contribution is selected and bounded by core before invocation.

## Manifest

`plugin.yml` contains a reverse-DNS-style ID, semantic version, API version, execution model,
entrypoint, permissions, contributions, and settings schema. Unknown fields are rejected. Settings
support string, secret, number, boolean, select, multi-select, and URL values. Secret values are
encrypted with the configured master key and never returned to plugin administration pages.

## Permissions and trusted versus sandboxed plugins

Requested permissions and granted permissions are separate. Installation grants none. An update
that adds permissions leaves the new capabilities denied until review. Trusted Node plugins are
equivalent to installing server software: arbitrary Node code can bypass application-level checks,
so the UI presents a prominent warning and administrators must review the author and supply chain.
Sandboxed WASM receives only explicit capability messages and has no ambient filesystem, network,
process, database, session, or DOM access.

## Server APIs and REST endpoints

Plugins register versioned contribution descriptors rather than receiving Fastify, SQLite, or
internal service objects. A contributed route is mounted below the plugin namespace. Each dispatch
checks enable state, the requesting user's repository permission, and the plugin's granted
capability before creating a redacted request context. Denied capabilities fail closed.

## UI contributions

API v1 defines repository tabs, bounded file renderers, sanitizer-enforced Markdown extensions,
global navigation, commands, command-palette search providers, authentication providers,
manifest-only themes, administrator integration pages, REST endpoints, events, and schema-rendered
settings as declarative contributions. Markdown extensions receive at most 1 MiB and return
Markdown—not HTML—before the core renderer and hostile-content sanitizer run.
Sandboxed output is rendered from the safe component vocabulary or in a
credentialless, opaque-origin iframe using a bounded postMessage bridge. It cannot read cookies,
CSRF values, tokens, arbitrary DOM, another plugin's data, or repositories outside its grants.

Authentication contributions require the separately approved `auth.provider` capability. Their
credential form is rendered by core with CSRF protection and login throttling. A provider returns a
strictly validated external identity; core alone links or creates the account, records the audit
event, and creates the session. Trusted providers can observe submitted credentials and therefore
carry the same prominent server-code trust warning as every trusted plugin.

## Events

The event API includes repository creation/deletion/rename/visibility/push, branch and tag changes,
and web commits. Payload fields are filtered by granted capabilities. Delivery is queued outside the
Git push latency path, bounded, retried, and visible to administrators. Core never converts an event
into an unrestricted shell hook.

## Plugin settings

The core Plugins page builds ordinary settings forms from the manifest schema. String, secret,
number, boolean, select, multi-select, and URL fields are supported. Secrets are write-only and
masked. Rich custom settings UI requires a UI permission and uses the same isolated contribution
boundary.

## Storage and removal

Plugins see only namespaced key/value storage through the host API. Values are limited to 1 MiB.
Removal can retain data in the orphan archive or remove it with the plugin record. Plugin packages
are moved to application trash rather than immediately erased.

## Playground

The administrator playground uses a credentialless, opaque-origin iframe with a mocked repository
and mocked capability APIs. It is suitable for UI and API experiments. It deliberately never runs
trusted editor code inside the application process.

## Example plugin

The plugin documentation page offers the Repository Word Count package as a download. It
demonstrates repository-content read permission, a repository tab, bounded file and Markdown
renderers, REST contribution, command, search provider, administrator integration, theme, schema
settings, events, and namespaced storage. It is a separate example package and is not enabled or
bundled into the running core application.

Core is AGPL-3.0-only. Plugins distributed as separate works may choose their own compatible legal
terms, but authors should obtain legal advice; copying core code creates AGPL obligations.
