# Pi Remote Control relay server.
# Build context: the remote/ directory (see docker/docker-compose.yml).
#   - server/  → /app/server/   (server.mjs + lib/ + package.json)
#   - web/     → /app/web/      (static SPA; http.mjs serves ../web relative to lib/)
FROM node:22-alpine

WORKDIR /app

# Install the single runtime dependency (ws) into /app/server/node_modules.
COPY server/package.json /app/server/package.json
RUN cd /app/server && npm install --omit=dev --no-audit --no-fund

COPY server/ /app/server/
COPY web/ /app/web/

# State (token, devices.json, log) lives in a mounted volume.
VOLUME ["/state"]

EXPOSE 4820

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4820/healthz > /dev/null 2>&1 || exit 1

ENTRYPOINT ["node", "/app/server/server.mjs"]
CMD ["--port=4820", "--state=/state"]
