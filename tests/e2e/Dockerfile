# Browser tests and the existing smoke CLI run in the same pinned Node toolchain.
FROM node:24-bookworm
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# The API imports wire types from the shared workspace package; its manifest must
# exist before install resolves the workspace links.
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter lct-smart-router --filter api...
RUN pnpm exec playwright install --with-deps chromium
COPY apps/api apps/api
COPY packages/shared packages/shared
# Integration tests boot the whole API module: the knowledge indexer scans the
# knowledge base at module init, so the files must be in the image.
COPY docs/knowledge docs/knowledge
COPY tests/e2e tests/e2e
RUN pnpm --filter api exec prisma generate && pnpm --filter api test:build
CMD ["sleep", "infinity"]
