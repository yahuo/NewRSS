FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

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
