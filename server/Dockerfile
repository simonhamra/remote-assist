# Build from the repository root:  docker build -f server/Dockerfile .
FROM node:24.22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install only the server's runtime dependencies. Every workspace manifest is copied so npm can
# check the lockfile (add new workspaces here), but nothing from the desktop apps gets installed.
COPY package.json package-lock.json ./
COPY apps/host/package.json apps/host/
COPY apps/helper/package.json apps/helper/
COPY packages/crypto/package.json packages/crypto/
COPY packages/desktop/package.json packages/desktop/
COPY packages/native-input/package.json packages/native-input/
COPY packages/protocol/package.json packages/protocol/
COPY packages/rtc/package.json packages/rtc/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace @remote-assist/server --ignore-scripts

# Node runs the TypeScript sources directly.
COPY packages/crypto/src packages/crypto/src
COPY packages/protocol/src packages/protocol/src
COPY server/src server/src

# Pairings live here; mount a volume so they survive updates.
RUN mkdir -p /data && chown node:node /data
ENV DATABASE_PATH=/data/remote-assist.db
VOLUME /data

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
# Node's built-in SQLite still prints an "experimental" warning on every start.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
