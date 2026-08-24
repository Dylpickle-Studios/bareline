# Deployment, TLS, and reverse proxies

## Docker

The production image runs as an unprivileged user. `docker compose up -d` uses the image's
`config.docker.yml`, whose storage paths all live under the persistent `/var/lib/bareline` volume.
The health check calls the application health endpoint. To customize the configuration, copy
`config.docker.yml` to `config.yml` and add a read-only Compose mount from that file to
`/etc/bareline/config.yml`. Keep the database, repositories, trash, LFS objects, plugins, and plugin
storage on the same backed-up volume unless configured paths deliberately place them elsewhere.

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

## Standalone bundle

The platform bundle contains the tested Node.js runtime, compiled sources, native modules, licenses,
and a launcher. It requires the system Git executable, but not a separately installed Node.js.
Native SQLite and Argon2 bindings make a platform-specific bundle more reliable than an opaque
single-file executable. Run `npm run release:bundle` on the target platform family.
