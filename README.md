# Samad Resources Fleet Dashboard

The fleet dashboard for Samad Resources: the live map of the trucks, the
drivers and their trips, overspeeding and dashcam alerts, route replay, the
weather and traffic layers, and user and role admin.

Two parts in one repository, shipped as one Docker image:

- **The dashboard** (`src/`): React + Vite, Redux Toolkit for client state,
  TanStack Query for server data, Leaflet for the map, SCSS for styles.
- **The server** (`server/`): Go (gorilla/mux). It polls the IntelliFleet360
  Partner API and serves the dashboard's API under `/api/v1`, plus the built
  dashboard itself. See [server/README.md](server/README.md).

**Contents:** [Quick start](#quick-start) · [How it fits together](#how-it-fits-together) ·
[Configuration](#configuration) · [Scripts](#scripts) · [Code layout](#code-layout) ·
[Deployment and versions](#deployment-and-versions) · [Troubleshooting](#troubleshooting) ·
[Further docs](#further-docs)

---

## Quick start

Run the server, then the dashboard, each in its own terminal:

```bash
cd server
cp .env.example .env              # fill in the Partner key, a JWT secret and the admin sign-in
go run . hash-password '<password>'   # prints ADMIN_PASSWORD_HASH for .env
go run .                          # API on http://localhost:8080
```

```bash
npm install
npm run dev                       # dashboard on http://localhost:5174, /api proxied to :8080
```

Sign in with the admin email and password from `server/.env`. To point the
dashboard at another API without editing the config:

```bash
VITE_PROXY_TARGET=http://<host> npm run dev
```

## How it fits together

```
Browser (dashboard)
  │ /api/v1/…, SSE /live
  ▼
Traefik (TLS) ──▶ samad (Go server + built dashboard) ──▶ PostgreSQL 18 + PostGIS
                        │
                        ├──▶ IntelliFleet360 Partner API   positions, events, geofences, dashcam clips
                        ├──▶ Google Routes / Weather       road routes, arrivals, weather layer
                        └──▶ OpenAI (optional)             the Fleet summary's AI brief

Browser ──▶ Google Maps     hybrid, satellite and terrain maps, live traffic
        ──▶ OpenStreetMap   default base map (no key)
```

- The server polls the partner every 30 s for positions and events, keeps the
  trips and kilometres per truck and driver, and pushes updates to the
  dashboard over the `/live` stream.
- The driver roster (names, ID and phone numbers, truck and trailer) lives in
  `drivers.json` in the server's data folder, never in git.

## Configuration

**Dashboard** (`.env.local`, gitignored, read at build time):

| Variable | Needed for | Without it |
|---|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | Google hybrid/satellite/terrain maps and live traffic | OpenStreetMap only, no traffic |
| `VITE_PROXY_TARGET` | Dev only: where `/api` is proxied | `http://localhost:8080` |

**Server** (`server/.env`, gitignored): every setting is listed with a comment
in [server/.env.example](server/.env.example): the Partner API key,
`JWT_SECRET`, the admin sign-in, `GOOGLE_MAPS_API_KEY` (or a separate
`GOOGLE_ROUTING_API_KEY`) and the optional OpenAI key.

Never commit `.env`, `.env.local`, keys or `drivers.json`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dashboard dev server on 5174 |
| `npm run build` | Production bundle into `build/` |
| `npm run preview` | Serve the built bundle locally |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint |
| `go run .` (in `server/`) | The API on 8080 |
| `go test ./...` (in `server/`) | Server tests |

## Code layout

| Path | What lives there |
|---|---|
| `src/index.jsx`, `src/App.jsx` | Entry and app shell |
| `src/api/` | One module per backend area |
| `src/services/` | Fetch wrapper, snapshot, live stream, first paint cache |
| `src/store/`, `src/context/`, `src/hooks/` | Redux slices, auth and live fleet context, data hooks |
| `src/lib/`, `src/utils/` | Pure logic (vehicle state, map adapter, version), formatting, reports |
| `src/components/body/` | The map, tool rail, Units panel, playback |
| `src/components/screens/` | Drivers, Alerts, Dashcam incidents, Fuel report, Users, Account, Login |
| `src/components/layout/`, `header/`, `footer/`, `cards/`, `shared/` | Panels, header, stat cards, shared pieces |
| `server/` | The Go API; `server/migrations/` holds the database schema |
| `deploy/` | The box's deploy script and Traefik setup |
| `.github/workflows/` | CI (`pipeline.yml`) and the deploy (`deploy.yml`) |

Tests sit beside the code they cover: `*.test.js(x)` and `*_test.go`.

## Deployment and versions

A push to `main` runs the pipeline: lint, tests, build, security scans, then
the image is built, scanned and pushed to `ghcr.io/ogc-ltd/samad`. The
production deploy waits for an approval, backs up the database, and rolls back
by itself if the new release is not healthy.

Every production deploy is **0.1 above the last, starting at 1.0**. The number
shows in the dashboard (sidebar foot, login page) and in
`/api/v1/health` → `version`, and the deployed commit is tagged `vX.Y`.

The full guide (the box, Traefik, secrets, migrations, rollbacks, backups) is
[DevOps.md](DevOps.md).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every `/api` call fails in dev | The Go server is not running on 8080, or `VITE_PROXY_TARGET` points elsewhere |
| "Invalid email or password" | The password does not match `ADMIN_PASSWORD_HASH` in `server/.env` (quote the hash) |
| No Google maps or traffic | `VITE_GOOGLE_MAPS_API_KEY` missing at build time |
| No routes or weather | No Google key in `server/.env`, or the Routes / Weather API not enabled on it |
| Page unstyled, no errors | Vite served empty CSS after a whole-file rewrite; touch the SCSS file |
| `npm run dev` exits: port in use | Another app holds 5174 |

## Further docs

- [DevOps.md](DevOps.md): building, shipping and running it
- [server/README.md](server/README.md): the API and the partner feed
- [docs/driver-rating.md](docs/driver-rating.md): how drivers are scored
