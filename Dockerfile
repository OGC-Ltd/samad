# syntax=docker/dockerfile:1.10
# Samad Resources fleet dashboard: the React app and its Go API in one image.
# The Go server serves the built app from STATIC_DIR and the API under
# /api/v1. It listens on 8080 inside the container and is meant to sit behind
# Traefik (see docker-compose.yml); it publishes no port of its own.
#
#   docker compose build --build-arg APP_COMMIT=$(git rev-parse --short HEAD) --build-arg APP_VERSION=1.0
#
# No key is built in. The Google keys live in the GitHub production
# environment; the deploy writes them into the box's server/.env, the server
# uses them for routes and weather, and hands the Maps key to the dashboard
# after sign-in (/auth/me).

# ── the dashboard ──────────────────────────────────────────────────────────
FROM node:26.12.1-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js postcss.config.js tailwind.config.js ./
COPY public ./public
COPY src ./src
ARG APP_COMMIT=""
ARG APP_VERSION=dev
ENV APP_COMMIT=${APP_COMMIT} APP_VERSION=${APP_VERSION} NODE_OPTIONS=--max-old-space-size=1536
RUN npm run build

# ── the API ────────────────────────────────────────────────────────────────
FROM golang:1.27.3-alpine AS api
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/*.go ./
ARG APP_VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${APP_VERSION}" -o /out/samad-server . \
 && mkdir -p /out/data

# ── what runs: no shell, no package manager, not root ─────────────────────
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=api /out/samad-server /app/samad-server
COPY --from=web /src/build /app/web
# The state file lives in a volume mounted here; the empty folder carries
# the owner a new volume takes.
COPY --from=api --chown=65532:65532 /out/data /data
ENV PORT=8080 DATA_DIR=/data STATIC_DIR=/app/web
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/app/samad-server", "healthcheck"]
ENTRYPOINT ["/app/samad-server"]
