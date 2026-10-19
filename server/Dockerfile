# Build from the repository root:  docker build -f server/Dockerfile .
FROM node:24.22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install only the server's runtime dependencies. Every workspace manifest is copied so npm can
# check the lockfile (add new workspaces here), but nothing from the desktop apps gets installed.
COPY package.json package-lock.json ./
COPY apps/host/package.json apps/host/
COPY apps/helper/package.json apps/helper/
COPY packages/desktop/package.json packages/desktop/
COPY packages/native-input/package.json packages/native-input/
COPY packages/protocol/package.json packages/protocol/
COPY packages/rtc/package.json packages/rtc/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace @remote-assist/server --ignore-scripts

# Node runs the TypeScript sources directly.
COPY packages/protocol/src packages/protocol/src
COPY server/src server/src

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/src/index.ts"]
