FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

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
