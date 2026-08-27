# Deployment, TLS, and reverse proxies

## Docker

The production image runs as an unprivileged user. `docker compose up -d` uses the image's
`config.docker.yml`, whose storage paths all live under the persistent `/var/lib/bareline` volume.
The health check calls the application health endpoint. To customize the configuration, copy
`config.docker.yml` to `config.yml` and add a read-only Compose mount from that file to
`/etc/bareline/config.yml`. Keep the database, repositories, trash, LFS objects, plugins, and plugin
storage on the same backed-up volume unless configured paths deliberately place them elsewhere.
The Compose example also makes the root filesystem read-only, drops Linux capabilities, enables
`no-new-privileges`, uses a no-exec temporary filesystem, and sets process and memory ceilings.
Treat these as defaults to review against the workload, not as a substitute for host/container
isolation or a network egress policy.

Allow outbound traffic only to explicitly required services (for example configured OIDC/LDAP,
mirror/plugin hosts, and the backup destination). Deny loopback, private, link-local, cloud metadata,
multicast, and other unintended destinations at the firewall or container-network layer. The
application repeats these checks for URL-based features and rejects redirects, but an application
check cannot constrain other processes or a compromised dependency.

## TLS modes

`server.tls.mode: proxy` is the recommended internet-facing arrangement. `http` is intended only
for a trusted private network. Native TLS reads an existing certificate and private key at startup:

```yaml
server:
  publicUrl: https://git.example.com
  tls:
    mode: native
    certificate: /etc/bareline/fullchain.pem
    privateKey: /etc/bareline/privkey.pem
```

Native TLS requires TLS 1.2 or newer. Certificate renewal remains the administrator's or proxy's
responsibility; the application does not implement ACME.

## Caddy

```caddyfile
git.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

## nginx

```nginx
server {
  listen 443 ssl http2;
  server_name git.example.com;
  ssl_certificate /etc/letsencrypt/live/git.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/git.example.com/privkey.pem;

  client_max_body_size 10m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_request_buffering off;
  }
}
```

## Traefik

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.git.rule=Host(`git.example.com`)
  - traefik.http.routers.git.entrypoints=websecure
  - traefik.http.routers.git.tls.certresolver=letsencrypt
  - traefik.http.services.git.loadbalancer.server.port=3000
```

Expose the application port only to the proxy. Never enable reverse-proxy authentication unless
untrusted clients cannot reach the application directly and the configured identity headers are
removed and replaced by that trusted proxy.

The readiness endpoints are `/livez` (process liveness) and `/readyz` (database, Git, and queue
readiness). `/metrics` is intentionally hidden from untrusted peers and should be scraped only from
localhost or an explicitly configured trusted proxy address/CIDR. Do not publish it through a public
proxy without an additional access-control layer.

## Standalone bundle

The platform bundle contains the tested Node.js runtime, compiled sources, native modules, licenses,
and a launcher. It requires the system Git executable, but not a separately installed Node.js.
Native SQLite and Argon2 bindings make a platform-specific bundle more reliable than an opaque
single-file executable. Run `npm run release:bundle` on the target platform family.

Verify the generated `SHA256SUMS` before installation. Container deployments should verify the
published immutable digest, SBOM, provenance attestation, and signature; tags are not deployment
identifiers. Keep the release record with the exact image, action, dependency, and runtime digests.
