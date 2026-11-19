# Build from the repo root: docker build -f hub/Dockerfile .
# (games.json lives at the repo root; the copy baked in here is a fallback for running the image alone.)
FROM node:22-alpine
WORKDIR /app
COPY hub/package.json hub/server.js hub/gate.js ./
COPY hub/public ./public
COPY games.json ./
# Party gate state. Owned by node so a new Docker named volume mounted here starts writable.
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
LABEL com.centurylinklabs.watchtower.enable="true"
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
USER node
CMD ["node", "server.js"]
