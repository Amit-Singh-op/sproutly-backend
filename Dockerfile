FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db ./db
COPY package.json ./
USER node
# Default = single-service hosting (Render): migrate + seed (both idempotent), then REST + Socket.IO + worker on one port.
# The API-only entry has no Socket.IO, so live messages, receipts, typing and presence never arrive.
# To scale out, override the command per service (api / realtime / worker) as docker-compose.yml does.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/db/seed.js && exec node dist/all.js"]
