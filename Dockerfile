# syntax=docker/dockerfile:1
# Node 24 is required: the app runs TypeScript directly and uses the built-in node:sqlite module.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY rules ./rules
COPY scripts ./scripts
COPY evidence/published ./evidence/published
COPY brand/favicon.ico brand/favicon-32.png brand/favicon-192.png ./brand/

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV PORT=3000 \
    DB_PATH=/app/data/discountwindow.sqlite

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
