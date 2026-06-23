FROM node:22-alpine

WORKDIR /app

# Copy package files for workspace resolution
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/collector/package.json ./apps/collector/

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
COPY apps/collector ./apps/collector

# Create data folder for SQLite database and set ownership
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV HOST=0.0.0.0
ENV PORT=8787
ENV DB_FILE=/app/data/token-tide.db
EXPOSE 8787

USER node
CMD ["node", "apps/server/src/server.mjs"]
