FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb

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
