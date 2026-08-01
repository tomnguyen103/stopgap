# Stopgap images (PROJECT_PLAN §11). Two targets out of one build:
#   docker build -f deploy/Dockerfile --target console .
#   docker build -f deploy/Dockerfile --target worker  .
#
# Debian rather than Alpine on purpose: @temporalio/core-bridge ships a prebuilt native
# addon per libc, and the musl path has bitten enough people that saving ~80 MB is not
# worth a runtime "cannot find module" on the VPS.
#
# The workspace packages are consumed as TypeScript source (they set `noEmit`), so the
# runtime images carry the sources and run them through Next's transpiler / tsx rather
# than a compiled dist. That is the same code path the local gate exercises.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /app

# ---- dependencies (cached on manifests alone) -------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/alerts/package.json packages/alerts/
COPY apps/console/package.json apps/console/
COPY packages/agents/package.json packages/agents/
COPY packages/comms/package.json packages/comms/
COPY packages/core/package.json packages/core/
COPY packages/catalog/package.json packages/catalog/
COPY packages/compliance/package.json packages/compliance/
COPY packages/db/package.json packages/db/
COPY packages/demo/package.json packages/demo/
COPY packages/ingest/package.json packages/ingest/
COPY packages/mcp/package.json packages/mcp/
COPY packages/observability/package.json packages/observability/
COPY packages/providers/package.json packages/providers/
COPY packages/scorer/package.json packages/scorer/
COPY packages/shadow/package.json packages/shadow/
COPY packages/shadow-ledger/package.json packages/shadow-ledger/
COPY packages/workflows/package.json packages/workflows/
RUN pnpm install --frozen-lockfile

# ---- source + console build --------------------------------------------------------------
FROM deps AS build
ARG KEYCLOAK_ISSUER=http://localhost:8080/realms/stopgap
# Next serializes `headers()` into the production route manifest at build time. The runtime
# container still receives the same value, but the public IdP origin must also be present here so
# the sign-in form's CSP is built for the deployment rather than the local default.
ENV KEYCLOAK_ISSUER=${KEYCLOAK_ISSUER}
COPY . .
RUN pnpm --filter @stopgap/console build

# ---- console ------------------------------------------------------------------------------
FROM build AS console
ENV NODE_ENV=production PORT=3000
# Drop root once the build is done — the runtime needs no privileges. The base image ships a
# `node` user; the workspace was installed as root, so hand ownership over before switching.
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@stopgap/console", "start"]

# ---- worker (Temporal activities + agents; also runs migrations and the demo seed) -------
FROM build AS worker
ENV NODE_ENV=production
RUN chown -R node:node /app
USER node
CMD ["pnpm", "--filter", "@stopgap/workflows", "worker"]
