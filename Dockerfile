# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts eslint.config.mjs ./
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @dbweb/api deploy --prod --legacy /opt/dbweb-api

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DBWEB_METADATA_FILE=/app/data/dbweb.sqlite
ENV DBWEB_WEB_ROOT=/app/web
WORKDIR /app

COPY --from=build --chown=node:node /opt/dbweb-api /app/api
COPY --from=build --chown=node:node /workspace/apps/web/dist /app/web
RUN mkdir -p /app/data && chown node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/api/dist/server.js"]
