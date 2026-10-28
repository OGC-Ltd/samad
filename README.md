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
[Configuration](#configuration) · [Scripts](#scripts) · [Code layout](#code-layout)

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
              │  /api/v1/…, SSE /live
              ▼
        Traefik (TLS)
              │
              ▼
   samad: Go server + built dashboard
              │
     ┌────────┼────────┬───────────┐
     ▼        ▼        ▼           ▼
 PostGIS   Partner   Google     OpenAI
             API     Routes,  (optional)
                     Weather
```

| Service | Called from | What for |
|---|---|---|
| PostgreSQL 18 + PostGIS | Server | The database |
| IntelliFleet360 Partner API | Server | Positions, events, geofences, dashcam clips |
| Google Routes and Weather | Server | Road routes, arrivals, the weather layer |
| OpenAI (optional) | Server | The Fleet summary's AI brief |
| Google Maps | Browser | Hybrid, satellite and terrain maps, live traffic |
| OpenStreetMap | Browser | The default base map (no key) |

- The server polls the partner every 30 s for positions and events, keeps the
  trips and kilometres per truck and driver, and pushes updates to the
  dashboard over the `/live` stream.
- The driver roster (names, ID and phone numbers, truck and trailer) lives in
  `drivers.json` in the server's data folder, never in git.

## Configuration

**Dashboard** (`.env.local`, gitignored, read at build time):

| Variable | Needed for | Without it |
|---|---|---|
| `VITE_PROXY_TARGET` | Dev only: where `/api` is proxied | `http://localhost:8080` |

The Google Maps key is not built in: the server hands it to the dashboard
after sign-in, from its own `GOOGLE_MAPS_API_KEY`.

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
