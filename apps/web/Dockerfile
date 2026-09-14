# syntax=docker/dockerfile:1
# Built from the repo root: the app depends on workspace packages, so the whole
# workspace has to be present for pnpm to link them.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH

# Manifests first, so a source-only change does not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/web/package.json ./apps/web/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---------------------------------------------------------------- dev
FROM base AS dev
COPY . .
ENV NODE_ENV=development
EXPOSE 3016
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------- build
FROM base AS build
COPY . .
RUN pnpm --filter @syntrix/web build

# ---------------------------------------------------------------- prod
FROM base AS prod
ENV NODE_ENV=production
COPY --from=build /app .
# Drop dev dependencies now that the build is done.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

USER node
EXPOSE 3016
CMD ["node", "apps/web/server.js"]
