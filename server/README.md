# samad-server

The API behind the Samad Resources fleet dashboard (the React app one folder
up). It reads the fleet from the IntelliFleet360 Partner API and serves it in
the shapes the dashboard expects. Go, gorilla/mux.

## Run

```bash
cp .env.example .env   # then fill in the key, a JWT secret and the sign-in
go run . hash-password '<password>'   # prints ADMIN_PASSWORD_HASH
go run .
```

The dashboard's dev server (`npm run dev` in the parent folder) proxies `/api`
to `http://localhost:8080`.

## Deploy (Docker, behind Traefik)

The repo root has a `Dockerfile` (the built dashboard and this server in one
distroless image, run as a non-root user) and a `docker-compose.yml` with
three services:

| Service | Image | Networks | Notes |
| --- | --- | --- | --- |
| `samad` | built here | `proxy`, `samad-db` | no published port; Traefik routes `SAMAD_DOMAIN` to it on 443 |
| `db` | `postgis/postgis:18-3.6` | `samad-db` (internal) | volume `samad-pgdata`; password from `secrets/postgres_password` |
| `migrate` | `migrate/migrate:v4.20.1` | `samad-db` | applies `server/migrations`, then exits; the app starts after it |

On the box (`/opt/samad`), with `server/.env`, `secrets/postgres_password` and
`SAMAD_DOMAIN` in `.env` beside the compose file:

```bash
docker compose up -d --build
docker compose run --rm migrate version      # which migration the database is on
docker compose exec db psql -U samad samad   # a SQL prompt
```

## Migrations

[golang-migrate](https://github.com/golang-migrate/migrate) files in
`migrations/`, one numbered `up`/`down` pair per step. A new step:

```bash
docker run --rm -v "$PWD/migrations:/migrations" migrate/migrate:v4.20.1 create -ext sql -dir /migrations -seq <name>
```

The schema is in place; the server still keeps its state in `data/state.json`
until its store is moved onto it.

## What it does

| Partner API | Polled | Serves |
| --- | --- | --- |
| `/partner/v1/positions` | every 30 s | `/vehicles/snapshot`, the `/live` stream, the drivers' daily km and trips |
| `/partner/v1/events` (cursor) | every 30 s | `/alerts*` (overspeeds and camera alarms), the live feed (every event) |
| `/partner/v1/vehicles`, `/geofences` | daily | unit names and drivers, `/geofences/geojson` |
| `/partner/v1/vehicles/{id}/positions` | on demand | `/track`, `/playback`, and a 7-day backfill on first start |

Requests to the partner are spaced 600 ms apart, under its 120/min and 30/10 s
limits. Received alarms, the feed cursor, read marks, decisions and the daily
tallies are kept in `data/state.json` (30 days).

Routes the dashboard calls for features Samad does not have yet (fuel,
repairs, weighbridges, routing) answer an empty list.

## Known gaps

- The partner's `/trips` and `/stoppages` are not enabled for this key (403),
  so trips and distance are worked out from positions.
- The partner does not say what speed limit its `over_speeding` uses; set
  `SPEED_LIMIT_KMH` to match (default 65).
- Accounts and roles (`users.go`, `roles.go`) are a JSON file in `DATA_DIR`,
  not yet the database; roles are code, with no role editor.
- No email: invitations hand the set-password link to the administrator.
- No dispatches: the road ahead runs only to a point picked on the map.
