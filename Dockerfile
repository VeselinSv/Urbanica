# Многоетапен образ: един и същ образ се използва за API (обслужва и клиента) и за worker-а.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/world-generation/package.json packages/world-generation/
COPY packages/economy-engine/package.json packages/economy-engine/
COPY packages/game-simulation/package.json packages/game-simulation/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY packages packages
COPY apps apps
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 gce
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/worker/package.json apps/worker/
COPY --from=build /app/apps/web/dist apps/web/dist
COPY scripts scripts
USER gce
EXPOSE 3000
# По подразбиране: миграции + API. За worker: CMD ["node", "apps/worker/dist/main.js"]
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/database/prisma/schema.prisma && node apps/api/dist/main.js"]
