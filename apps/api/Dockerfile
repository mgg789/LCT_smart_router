# System Layer image. Build context is the repository root: the pnpm workspace manifest
# and the lockfile live there, and a workspace install needs both.
#
# Debian-based slim images are used throughout, without mixing musl and manylinux
# artifacts in one contour (context/43 section 11.1).

FROM node:24-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
# Prisma's query engine links against OpenSSL and, without it, tries to download a
# different engine build at run time -- which then fails inside a read-only, non-root
# container. Installing it here is the documented fix for Debian slim images.
RUN apt-get update   && apt-get install -y --no-install-recommends openssl ca-certificates   && rm -rf /var/lib/apt/lists/*
# Pinning the package manager in the image keeps the build reproducible and stops
# corepack from fetching pnpm on every container start.
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
# A frozen install is the point of committing the lockfile: CI must fail on drift
# instead of quietly resolving a different tree.
RUN pnpm install --frozen-lockfile --filter api...

FROM deps AS build
WORKDIR /app
COPY apps/api apps/api
# Codegen before compilation: the generated client is TypeScript and is compiled into
# dist together with the rest of the service. `generate` never connects to a database.
RUN pnpm --filter api exec prisma generate && pnpm --filter api build

FROM node:24-slim AS runtime
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV NODE_ENV=production
RUN apt-get update   && apt-get install -y --no-install-recommends openssl ca-certificates   && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --prod --filter api... && pnpm store prune
COPY --from=build /app/apps/api/dist apps/api/dist
# The schema, its migration history and the CLI config travel with the image: the
# one-shot `migrate` service runs `prisma migrate deploy` from this same image, so the
# code and the schema it expects can never be two different versions.
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts

USER node
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/src/main.js"]
