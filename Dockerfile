FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/data/codex-auth /app/backups \
    && chown -R node:node /app/data /app/backups

ENV NODE_ENV=production \
    PORT=8787
EXPOSE 8787

USER node

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
