# The dashboard. Its own stage because it has its own dependency tree — React
# and Vite have no business in the image that runs the service, and only the
# built files cross over.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS dashboard
WORKDIR /ui

COPY ui/package.json ui/yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-engines

COPY ui/ ./
RUN yarn build

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --ignore-engines

COPY . .
RUN yarn build

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --production --ignore-engines --network-timeout 600000

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim

RUN groupadd -g 1001 gryt && useradd -m -u 1001 -g 1001 -d /app -s /usr/sbin/nologin gryt
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

COPY --from=deps --chown=gryt:gryt /app/node_modules ./node_modules
COPY --from=builder --chown=gryt:gryt /app/package.json ./package.json
COPY --from=builder --chown=gryt:gryt /app/dist ./dist
COPY --from=dashboard --chown=gryt:gryt /dist-ui ./dist-ui
# The mark the digest attaches. `digest.ts` reads it relative to dist/, so it
# has to sit beside dist rather than inside it — the compiler does not copy
# non-TypeScript files and this is the only asset the service ships.
COPY --from=builder --chown=gryt:gryt /app/assets ./assets

# Every report anyone has ever sent lives in here. Mount it.
RUN mkdir -p /data && chown -R gryt:gryt /data
VOLUME ["/data"]

# The tag is the source of truth for a release and package.json is never
# bumped, so the version has to be handed in at build time — the same
# arrangement as image-worker, for the same reason.
ARG REPORTS_VERSION=""
ENV REPORTS_VERSION=$REPORTS_VERSION

USER gryt
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
