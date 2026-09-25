# Browser tests and the existing smoke CLI run in the same pinned Node toolchain.
FROM node:24-bookworm
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter lct-smart-router --filter api...
RUN pnpm exec playwright install --with-deps chromium
COPY apps/api apps/api
COPY tests/e2e tests/e2e
RUN pnpm --filter api exec prisma generate && pnpm --filter api test:build
CMD ["sleep", "infinity"]
