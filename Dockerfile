FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

USER node
CMD ["node", "apps/server/src/server.mjs"]
