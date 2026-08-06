FROM docker.io/library/node:24-bookworm-slim AS build
LABEL project=game-servers-hub

WORKDIR /src
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY backend/ backend/
COPY frontend/ frontend/
RUN npm run build:backend \
    && npm run build:frontend \
    && npm prune --omit=dev

FROM docker.io/library/node:24-bookworm-slim
LABEL project=game-servers-hub

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Game Servers Manager Hub" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV HUB_COMMIT=${GIT_COMMIT}
ENV HUB_BUILD_DATE=${BUILD_DATE}
ENV NODE_ENV=production
ENV PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git podman python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY --from=build /src/node_modules/ node_modules/
COPY --from=build /src/backend/dist/ backend/dist/
COPY --from=build /src/frontend/dist/ frontend/dist/
COPY config/manager.toml config/manager.toml

EXPOSE 4000/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/api/health >/dev/null || exit 1

CMD ["node", "backend/dist/server.js"]
