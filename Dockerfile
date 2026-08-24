FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json eslint.config.js .prettierrc.json ./
COPY scripts ./scripts
COPY src ./src
COPY docs ./docs
COPY plugins ./plugins
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 bareline \
    && useradd --system --uid 10001 --gid bareline --home-dir /var/lib/bareline --shell /usr/sbin/nologin bareline
WORKDIR /app
COPY --from=build --chown=bareline:bareline /build/package.json /build/package-lock.json ./
COPY --from=build --chown=bareline:bareline /build/node_modules ./node_modules
COPY --from=build --chown=bareline:bareline /build/dist ./dist
COPY --chown=bareline:bareline config.docker.yml /etc/bareline/config.yml
RUN mkdir -p /var/lib/bareline && chown bareline:bareline /var/lib/bareline
USER 10001:10001
VOLUME ["/var/lib/bareline"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve", "--config", "/etc/bareline/config.yml"]
