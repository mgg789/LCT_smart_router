# System Layer image. Build context is the repository root: the pnpm workspace manifest
# and the lockfile live there, and a workspace install needs both.
#
# Debian-based slim images are used throughout, without mixing musl and manylinux
# artifacts in one contour (context/43 section 11.1).

FROM node:24-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
# A frozen install is the point of committing the lockfile: CI must fail on drift
# instead of quietly resolving a different tree.
RUN pnpm install --frozen-lockfile --filter api...

FROM deps AS build
WORKDIR /app
COPY apps/api apps/api
RUN pnpm --filter api build

FROM node:24-slim AS runtime
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --prod --filter api... && pnpm store prune
COPY --from=build /app/apps/api/dist apps/api/dist

USER node
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/src/main.js"]
