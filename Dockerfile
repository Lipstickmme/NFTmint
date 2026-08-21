# The persistent tracker, for a host that stays on.
#
# This exists because of how serverless billing works: a function holding a
# WebSocket to the sequencer feed is billed as active CPU for every second it
# waits, so the thing this bot most wants to do — listen continuously — is the
# thing Vercel charges most for. Here it costs nothing extra, because the
# machine is already running.
#
# Built for arm64 as well as amd64, because the free tiers worth using
# (Oracle Ampere A1, GCP e2-micro) are the ones this image has to run on.

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY api ./api
RUN npm run build

# Prune to what the tracker actually runs on. tsx is a devDependency, so the
# runtime stage runs the compiled output directly rather than the sources.
RUN npm ci --omit=dev

# ---- run --------------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# tini reaps and forwards signals, so `docker stop` reaches the SIGINT handler
# that closes the feed and the server rather than killing PID 1 outright.
RUN apk add --no-cache tini

# TRACKER_HOST: a container is a deliberate public bind by definition, and
# loopback here would only mean nothing outside the container could reach it.
# The entrypoint refuses to start without a token because of that.
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TRACKER_HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Runs unprivileged. /data holds sealed wallet keys, so it belongs to this user
# and nobody else — see the mode the file store writes with in src/kv.ts.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080

# Auth is required whenever a token is set, so the check presents one. With no
# token set the header is ignored and the request still passes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null \
      --header="Authorization: Bearer ${TRACKER_AUTH_TOKEN}" \
      "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
