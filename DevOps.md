# Samad Resources — DevOps guide

How the Samad fleet dashboard is built, shipped and run: the server, the
containers, the database, the pipeline, and what to do at each step. Every
command here has been run against the real box. Secrets are never written in
this file; it says where each one lives.

**Contents**

1. [The system at a glance](#1-the-system-at-a-glance)
2. [Access: keys, users, passwords](#2-access-keys-users-passwords)
3. [Preparing the server](#3-preparing-the-server)
4. [Traefik: the front door](#4-traefik-the-front-door)
5. [The application image](#5-the-application-image)
6. [The stacks: production and dev](#6-the-stacks-production-and-dev)
7. [The database and migrations](#7-the-database-and-migrations)
8. [Secrets and configuration](#8-secrets-and-configuration)
9. [The CI/CD pipeline](#9-the-cicd-pipeline)
10. [One-time GitHub setup](#10-one-time-github-setup)
11. [Day-to-day: shipping a change](#11-day-to-day-shipping-a-change)
12. [Deploying, rolling back, checking by hand](#12-deploying-rolling-back-checking-by-hand)
13. [Backups and restoring](#13-backups-and-restoring)
14. [Moving to the real domain](#14-moving-to-the-real-domain)
15. [Logs, health and troubleshooting](#15-logs-health-and-troubleshooting)
16. [Security measures in place](#16-security-measures-in-place)
17. [Rebuilding the box from nothing](#17-rebuilding-the-box-from-nothing)
18. [Open items](#18-open-items)

---

## 1. The system at a glance

```
                        Internet
                           │  80 → redirect, 443 (Let's Encrypt)
                 ┌─────────▼─────────┐
                 │      Traefik      │  /opt/traefik      network: proxy
                 └───┬───────────┬───┘
        Host: 13-247-…sslip.io   Host: dev.13-247-…sslip.io
       ┌─────────────▼──┐     ┌──▼─────────────┐
       │ samad          │     │ samad-dev      │   the Go API + built React app
       │ (production)   │     │ (dev)          │   (one distroless image)
       └──────┬─────────┘     └──────┬─────────┘
   samad-db (internal)        samad-dev-db (internal)
       ┌──────▼─────────┐     ┌──────▼─────────┐
       │ samad-db       │     │ samad-dev-db   │   PostgreSQL 18 + PostGIS 3.6
       │ vol samad-pgdata│    │ vol samad-dev-pgdata
       └────────────────┘     └────────────────┘
```

| Piece | What it is |
| --- | --- |
| Server | AWS EC2, `af-south-1`, Ubuntu 26.04, 2 vCPU, 1.9 GB RAM + 2 GB swap, 15 GB disk |
| Host | `ec2-13-247-156-214.af-south-1.compute.amazonaws.com` (`13.247.156.214`) |
| Production | `https://13-247-156-214.sslip.io` (until the real domain, [§14](#14-moving-to-the-real-domain)) |
| Dev | `https://dev.13-247-156-214.sslip.io` |
| App | Go server (`server/`, gorilla/mux) serving the API under `/api/v1` and the React app (`src/`) |
| Data source | IntelliFleet360 Partner API (positions, events, geofences, dashcam clips) |
| Database | PostGIS, schema managed by golang-migrate (`server/migrations/`) |
| Registry | `ghcr.io/ogc-ltd/samad` (GitHub Container Registry, private) |
| Pipeline | GitHub Actions, `.github/workflows/pipeline.yml` and `deploy.yml` |

`sslip.io` is a free DNS name that resolves to the IP written in it; it lets
Let's Encrypt issue a real certificate before the company domain exists.

---

## 2. Access: keys, users, passwords

The private keys sit in the `keys/` folder next to this repository (on the
workstation, **never in git**).

| File | What it opens |
| --- | --- |
| `keys/samad.pem` | the AWS key pair: SSH as `ubuntu` or `admin` |
| `keys/samad-deploy` | CI's key: SSH as `deploy`, **can only run the deploy script** |
| `keys/samad-deploy.pub` | its public half (installed on the box) |
| `keys/samad-known_hosts` | the box's SSH host key, for CI to pin |
| `keys/samad-admin-password.txt` | the `admin` user's password |

**Users on the box**

| User | For | Can |
| --- | --- | --- |
| `ubuntu` | AWS default | sudo, docker |
| `admin` | people | sudo without a password, docker, reads the stack folders (group `deploy`) |
| `deploy` | CI | docker; password locked; its one key is bound to `/usr/local/bin/samad-deploy` |

**Act on it**

```bash
# connect (from the folder that holds keys/)
ssh -i keys/samad.pem admin@ec2-13-247-156-214.af-south-1.compute.amazonaws.com
```

- SSH accepts keys only (`PasswordAuthentication no`). The `admin` password is
  for `sudo` prompts, should you remove `/etc/sudoers.d/90-admin`, and for the
  EC2 Serial Console if SSH ever breaks.
- To give someone access: add their public key to `/home/admin/.ssh/authorized_keys`
  (or create them a user the same way as `admin`, [§3.5](#35-the-admin-user)).
- To revoke CI: delete the line in `/home/deploy/.ssh/authorized_keys`.
- The dashboard sign-in (one account) is `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` in
  each stack's `server/.env` ([§8](#8-secrets-and-configuration)).

---

## 3. Preparing the server

These were done once, in this order. Re-run them only on a new box
([§17](#17-rebuilding-the-box-from-nothing)).

### 3.1 Go

The latest release into `/usr/local/go`, on everyone's PATH:

```bash
V=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1)
curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/$V.linux-amd64.tar.gz"
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh
go version        # in a new login shell
```

Go on the box is for tooling; the app is built inside Docker (and by CI).

### 3.2 Docker Engine and Compose

From Docker's own apt repository, so it updates with the system:

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release; echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

### 3.3 Swap

2 GB RAM is tight for a build or a busy database; 2 GB of swap absorbs peaks.

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf && sudo sysctl -p /etc/sysctl.d/99-swap.conf
swapon --show && free -h
```

Swappiness 10: keep working memory in RAM, swap only near the limit. Checked
after a reboot: swap and swappiness come back on their own.

### 3.4 The `deploy` group and folders

Done by the stack setup in [§6.3](#63-setting-up-a-stack-folder); the deploy
user in [§9.4](#94-the-deploy-user-and-its-forced-command).

### 3.5 The admin user

Ubuntu already has an `admin` group (gid 107, a sudo group), so the user joins
it rather than getting a new one:

```bash
sudo useradd -m -s /bin/bash -g admin -G sudo,docker admin
sudo install -d -m 700 -o admin -g admin /home/admin/.ssh
sudo install -m 600 -o admin -g admin /home/ubuntu/.ssh/authorized_keys /home/admin/.ssh/authorized_keys
echo 'admin ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-admin && sudo chmod 440 /etc/sudoers.d/90-admin
sudo visudo -c
# a password (stored in keys/samad-admin-password.txt), for console/sudo use:
printf 'admin:%s\n' "<password>" | sudo chpasswd
```

---

## 4. Traefik: the front door

Traefik takes ports 80 and 443, gets certificates from Let's Encrypt, and routes
each domain to its container. Nothing else on the box listens on the internet.

Files: `/opt/traefik` on the box; the same files are in this repo under
`deploy/traefik/`.

| File | Purpose |
| --- | --- |
| `traefik.yml` | entry points (80 → 443 redirect, 443 with TLS), Docker provider (only containers labelled `traefik.enable=true` on the `proxy` network), Let's Encrypt HTTP challenge, headers that impersonate Traefik's own are dropped (`aliasHeadersStrategy: delete`) |
| `docker-compose.yml` | Traefik v3.7.16, read-only Docker socket, `no-new-privileges`, health check, dashboard on `127.0.0.1:8080` only |
| `letsencrypt/acme.json` | issued certificates (mode 600) |
| `dynamic/` | extra routes from files, picked up without a restart |

**Install (once)**

```bash
sudo install -d -o admin -g admin /opt/traefik /opt/traefik/dynamic /opt/traefik/letsencrypt
cp deploy/traefik/traefik.yml deploy/traefik/docker-compose.yml /opt/traefik/   # from a copy of this repo
touch /opt/traefik/letsencrypt/acme.json && chmod 600 /opt/traefik/letsencrypt/acme.json
docker network create proxy
cd /opt/traefik && docker compose up -d
```

**Act on it**

- See the dashboard: open a tunnel, then browse `http://localhost:8080`:
  ```bash
  ssh -i keys/samad.pem -L 8080:127.0.0.1:8080 admin@ec2-13-247-156-214.af-south-1.compute.amazonaws.com
  ```
- Upgrade: change the image tag in `/opt/traefik/docker-compose.yml` (and in
  `deploy/traefik/`), then `cd /opt/traefik && docker compose up -d`.
- Certificates renew themselves. A domain gets one the first time it is
  requested, if its DNS points at the box and port 80 is reachable.
- The AWS security group must allow inbound 22, 80 and 443 only.

---

## 5. The application image

`Dockerfile` (repo root) builds one image with three stages:

1. **web**: `node:24.19.0-alpine`, `npm ci`, `npm run build`. The Google Maps key
   comes in as a BuildKit **secret** (`id=google_maps_key`), never a layer.
2. **api**: `golang:1.27.3-alpine`, a static binary (`CGO_ENABLED=0 -trimpath -s -w`).
3. **run**: `gcr.io/distroless/static-debian12:nonroot`: no shell, no package
   manager, user 65532. Holds the binary, the built app (`/app/web`), an empty
   `/data` owned by the app user, and a `HEALTHCHECK` that runs
   `samad-server healthcheck`.

About 43 MB. The server serves the app; a missing file (anything with an
extension, anything under `/api` or in a hidden folder) is a 404, so scanners
asking for `/.env` or `/secrets.json` get nothing.

**Act on it**

- CI builds and pushes it ([§9](#9-the-cicd-pipeline)); you normally never build by hand.
- To build on a workstation with Docker:
  ```bash
  VITE_GOOGLE_MAPS_API_KEY=... docker build \
    --secret id=google_maps_key,env=VITE_GOOGLE_MAPS_API_KEY \
    --build-arg APP_COMMIT=$(git rev-parse --short HEAD) -t samad:local .
  ```
- `.dockerignore` keeps `.env` files, `secrets/`, `node_modules/`, `.git/` and
  build output out of the build context.

---

## 6. The stacks: production and dev

`docker-compose.yml` (repo root) describes one stack; the `STACK` variable
names everything in it, so two stacks share the box without touching each
other.

| | Production | Dev |
| --- | --- | --- |
| Folder | `/opt/samad` | `/opt/samad-dev` |
| `STACK` | `samad` | `samad-dev` |
| Containers | `samad`, `samad-db`, `samad-migrate` | `samad-dev`, `samad-dev-db`, `samad-dev-migrate` |
| Volumes | `samad-data`, `samad-pgdata` | `samad-dev-data`, `samad-dev-pgdata` |
| DB network | `samad-db` (internal) | `samad-dev-db` (internal) |
| Traefik routers | `samad`, `samad-auth` | `samad-dev`, `samad-dev-auth` |
| Limits | app 512 MB, db 768 MB | app 384 MB, db 384 MB (64 MB shared buffers) |
| Deployed from | `main`, after approval | `develop`, automatically |

### 6.1 Services

| Service | Image | Networks | Notes |
| --- | --- | --- | --- |
| `samad` | `${SAMAD_IMAGE}` | `proxy`, `<stack>-db` | no published port; Traefik routes `SAMAD_DOMAIN` to its port 8080 |
| `db` | `postgis/postgis:18-3.6` | `<stack>-db` | volume at `/var/lib/postgresql` (PostgreSQL 18 layout); password from a Docker secret |
| `migrate` | `migrate/migrate:v4.20.1` | `<stack>-db` | runs `up`, exits; the app starts only after it succeeds |

Order on `docker compose up`: `db` healthy → `migrate` completes → `samad` starts.

### 6.2 Networking

- Only Traefik publishes ports (80, 443; 8080 on localhost).
- The app is on `proxy` (so Traefik reaches it, and it reaches the Partner API,
  the video host and OpenAI) and on its stack's internal DB network.
- The DB network is `internal: true`: no gateway, no internet, no port on the
  host. Dev cannot resolve production's database, and the reverse.

### 6.3 Setting up a stack folder

Each folder holds only configuration; the code arrives as an image.

```
/opt/<stack>/
├── .env                      STACK, SAMAD_DOMAIN, SAMAD_IMAGE, limits     (640)
├── docker-compose.yml        written by each deploy
├── server/.env               the app's secrets                             (640)
├── server/migrations/        written by each deploy
├── secrets/postgres_password the database password                         (644 in a 750 folder)
├── releases/                 the last 5 releases, for rollback
└── backups/                  pre-deploy database dumps (production)
```

To create one (dev shown; production is the same with its own values):

```bash
sudo install -d -m 750 -o deploy -g deploy /opt/samad-dev /opt/samad-dev/server /opt/samad-dev/secrets
# app secrets: start from server/.env.example and fill in (see §8); quote the bcrypt hash
sudo -u deploy cp server/.env.example /opt/samad-dev/server/.env && sudo -u deploy nano /opt/samad-dev/server/.env
# database password
openssl rand -base64 32 | tr -d '\n/+=' | sudo -u deploy tee /opt/samad-dev/secrets/postgres_password >/dev/null
sudo chmod 644 /opt/samad-dev/secrets/postgres_password
# the stack's own settings
printf 'STACK=samad-dev\nSAMAD_DOMAIN=dev.13-247-156-214.sslip.io\nDB_MEM_LIMIT=384m\nDB_SHARED_BUFFERS=64MB\nAPP_MEM_LIMIT=384m\n' \
  | sudo -u deploy tee /opt/samad-dev/.env
sudo chmod 640 /opt/samad-dev/.env /opt/samad-dev/server/.env
```

The first CI deploy then writes `docker-compose.yml`, `server/migrations/` and
`SAMAD_IMAGE`.

### 6.4 Everyday commands (on the box, in a stack folder)

```bash
cd /opt/samad                                 # or /opt/samad-dev
sudo -u deploy docker compose ps              # what runs, health
sudo -u deploy docker compose logs -f samad   # the app's log
sudo -u deploy docker compose restart samad   # restart the app only
sudo -u deploy docker compose up -d --wait    # apply a changed .env or compose file
docker stats --no-stream                      # memory and CPU per container
```

(`sudo -u deploy` because the folders belong to `deploy`; `admin` can read them.)

---

## 7. The database and migrations

PostgreSQL 18.6 with PostGIS 3.6.4. Passwords are checked with SCRAM over the
network; inside the container the socket trusts local users, and only
`docker compose exec` reaches it.

### 7.1 The schema

golang-migrate files in `server/migrations/`, one numbered `up`/`down` pair per step:

| # | Step | Tables |
| --- | --- | --- |
| 1 | core | `organisations` (Samad seeded), `users` |
| 2 | fleet | `drivers`, `vehicles`, `vehicle_positions_latest`, `vehicle_positions` (GiST + BRIN) |
| 3 | geofences | `geofences`: circle (`center` + `radius_m`) or polygon (`boundary`), and a generated `area` for point-in-zone queries |
| 4 | events and alerts | `events` (with dashcam clip URLs), `alert_decisions`, `alert_reads`, `alert_read_all` |
| 5 | daily stats and sync | `vehicle_days`, `backfilled_days`, `sync_state` |

Extensions: `postgis`, `citext` (case-insensitive emails).

> The schema is in place, but the server still keeps its state in
> `/data/state.json`. Moving the store onto these tables is the next piece of
> application work ([§18](#18-open-items)).

### 7.2 Writing a migration

```bash
# from the repo, with Docker:
docker run --rm -v "$PWD/server/migrations:/migrations" migrate/migrate:v4.20.1 \
  create -ext sql -dir /migrations -seq add_trip_table
```

Then fill both files. Rules:

1. **Every `up` has a `down`** that undoes it exactly (CI checks this, and runs up → down all → up).
2. **Never edit a migration that has shipped**; add a new one.
3. **Keep the previous release working** (expand, then contract): add a column
   or table in one release, stop using the old one in the next, drop it in a
   third. A rollback ([§12](#12-deploying-rolling-back-checking-by-hand)) puts
   the old app back on the *new* schema.
4. Big tables: create indexes `CONCURRENTLY` in a migration of their own.

### 7.3 Commands (on the box, in a stack folder)

```bash
sudo -u deploy docker compose run --rm migrate version     # current version
sudo -u deploy docker compose run --rm migrate up          # apply pending
sudo -u deploy docker compose run --rm migrate down 1      # undo the last one (careful in production)
sudo -u deploy docker compose exec db psql -U samad samad  # SQL prompt
```

If a migration fails half way, golang-migrate marks the version **dirty**.
Fix the data or the SQL by hand, then tell it where things stand:

```bash
sudo -u deploy docker compose run --rm migrate force <last good version>
```

---

## 8. Secrets and configuration

| Secret | Where it lives | Used by |
| --- | --- | --- |
| Partner API key | `server/.env` → `PARTNER_API_KEY` (each stack) | the app, server side |
| Token signing secret | `server/.env` → `JWT_SECRET` (different per stack) | the app |
| Dashboard sign-in | `server/.env` → `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` | the app |
| OpenAI key | `server/.env` → `OPENAI_API_KEY` (optional), `OPENAI_MODEL` | the Fleet summary's AI brief |
| Database password | `secrets/postgres_password` (each stack) | `db`, `migrate` |
| Google Maps key | GitHub secret `GOOGLE_MAPS_API_KEY`; local `.env.local` | baked into the dashboard at build |
| CI deploy key | GitHub secret `SAMAD_DEPLOY_KEY` | the deploy job |
| Box host key | GitHub secret `SAMAD_DEPLOY_KNOWN_HOSTS` | the deploy job |

`server/.env.example` lists every setting with a comment.

**Act on it**

- **Change the dashboard password**:
  ```bash
  cd server && go run . hash-password 'new password'     # on a workstation
  ```
  Put the result in the stack's `server/.env` **in single quotes**
  (`ADMIN_PASSWORD_HASH='$2a$10$…'`; Compose reads every `$` as a variable
  otherwise), then `sudo -u deploy docker compose up -d --wait`.
- **Rotate the Partner, OpenAI or JWT secret**: edit `server/.env` in each
  stack, then `docker compose up -d --wait`. A new `JWT_SECRET` signs everyone out.
- **Rotate the Google Maps key**: update the GitHub secret, then re-run the
  pipeline (the key is in the built bundle, so it needs a new image).
- **Rotate the database password**: change it in Postgres
  (`ALTER USER samad PASSWORD '…'`), then write the same value to
  `secrets/postgres_password` and `docker compose up -d --wait`.
- **The Google Maps key is public by nature** (every browser gets it). Protect
  it in Google Cloud Console → Credentials: HTTP referrers = the site's
  domains, API = Maps JavaScript API only.
- **The OpenAI account needs credits** for the AI brief; without them the card
  says "AI unavailable" and shows the plain facts. The model only sees counts,
  alarm types and plates, never driver names, and `store: false` is sent.

---

## 9. The CI/CD pipeline

### 9.1 The flow

```
pull request ─┐
push develop ─┼─▶ web · go · migrations · security ─▶ image ─┬─▶ deploy dev         (develop)
push main ────┘        (all must pass)        build, scan,   └─▶ deploy production  (main, approval)
                                              push to GHCR
```

### 9.2 The jobs

| Job | Checks | Fails when |
| --- | --- | --- |
| **web** | `npm ci`, ESLint `--max-warnings=0`, Vitest, `vite build`, `npm audit --omit=dev --audit-level=high` | any lint warning, test, build error, high/critical advisory |
| **go** | gofmt, `go mod tidy -diff`, `go vet`, golangci-lint (`server/.golangci.yml`: gosec, staticcheck, errcheck, bodyclose, noctx, errorlint, gocritic, …), `go test -race` + coverage, govulncheck | any finding, test, or reachable vulnerability |
| **migrations** | PostGIS service; `up`, `down -all`, `up`; version = highest file; every `up` has a `down` | any SQL error or missing `down` |
| **security** | gitleaks (full history), hadolint (Dockerfile), shellcheck (deploy script), actionlint (workflows), `docker compose config`, Trivy fs (dependencies, secrets, misconfiguration) | any secret, high/critical finding, warning-level lint |
| **snyk** | Snyk Open Source + Snyk Code, only with a `SNYK_TOKEN` secret | high and up |
| **image** | Buildx with cache, Trivy image scan (fixable high/critical), the image started read-only as non-root and asked for `/api/v1/health` and `/`, then pushed with SBOM + provenance (and, opt-in, a GitHub attestation) | a scan finding or a failed start |
| **deploy-dev / deploy-prod** | `deploy.yml` → the box's deploy script ([§12](#12-deploying-rolling-back-checking-by-hand)) | the new release is not healthy (and it rolls back) |

Pull requests run everything except the push and the deploys.

### 9.3 What keeps it trustworthy

- Every third-party action is pinned to a **commit SHA**, with its version in a
  comment. Scanners (Trivy, gitleaks, hadolint, shellcheck, actionlint) run
  from **pinned images**, so no outside action holds the repository token.
- `persist-credentials: false` on every checkout; the default token is
  read-only, and each job asks only for what it needs (`packages: write` only
  to push the image).
- Go's toolchain comes from `go.mod` (`toolchain go1.27.3`, the patched release).
- Production deploys the **digest** of the image that was just built and
  scanned, never a moving tag.
- **Dependabot** (`.github/dependabot.yml`) proposes updates weekly for actions,
  npm, Go modules and base images; each runs the full pipeline.

### 9.4 The deploy user and its forced command

CI's SSH key is installed like this, so whatever it asks for is handed to the
script as words and nothing else can run:

```
restrict,command="/usr/local/bin/samad-deploy" ssh-ed25519 AAAA… github-actions@OGC-Ltd/samad
```

```bash
sudo useradd -m -s /bin/bash -G docker deploy && sudo passwd -l deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo "restrict,command=\"/usr/local/bin/samad-deploy\" $(cat samad-deploy.pub)" | sudo tee /home/deploy/.ssh/authorized_keys
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys && sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo install -m 755 -o root -g root deploy/deploy.sh /usr/local/bin/samad-deploy
sudo usermod -aG deploy admin
```

Tested refusals: shell commands, an interactive terminal, `$(…)` and `;`
injection, a non-GHCR or tag-only image, a bundle with an extra file, and port
forwarding ("administratively prohibited").

**When `deploy/deploy.sh` changes**, CI does not install it (on purpose: a
pull request must not be able to change what the box runs as root-owned
code). Install it by hand after review:

```bash
scp -i keys/samad.pem deploy/deploy.sh admin@<host>:/tmp/
ssh -i keys/samad.pem admin@<host> 'sudo install -m 755 -o root -g root /tmp/deploy.sh /usr/local/bin/samad-deploy && rm /tmp/deploy.sh'
```

---

## 10. One-time GitHub setup

Repository **OGC-Ltd/samad → Settings**. Do these before the first push of the
pipeline, or the deploy jobs fail (the checks still run).

**Step 1: Environments** (Settings → Environments → New environment)

| Environment | Deployment branches | Protection | Variable |
| --- | --- | --- | --- |
| `development` | `develop` only | none | `SAMAD_URL` = `https://dev.13-247-156-214.sslip.io` |
| `production` | `main` only | **Required reviewers**: who approves; optionally a wait timer | `SAMAD_URL` = `https://13-247-156-214.sslip.io` |

**Step 2: Secrets** (Settings → Secrets and variables → Actions → New repository secret)

| Name | Value |
| --- | --- |
| `SAMAD_DEPLOY_KEY` | the whole of `keys/samad-deploy` (begins `-----BEGIN OPENSSH PRIVATE KEY-----`) |
| `SAMAD_DEPLOY_KNOWN_HOSTS` | the whole of `keys/samad-known_hosts` (one `… ssh-ed25519 …` line) |
| `GOOGLE_MAPS_API_KEY` | the Maps browser key |
| `SNYK_TOKEN` | optional: from snyk.io → Account settings |

**Step 3: Variables** (same page, Variables tab)

| Name | Value |
| --- | --- |
| `SAMAD_DEPLOY_HOST` | optional: only if the box moves (the workflow defaults to `ec2-13-247-156-214.af-south-1.compute.amazonaws.com`) |
| `ENABLE_ATTESTATIONS` | optional: `true` only on GitHub Enterprise Cloud |

**Step 4: Branch protection** (Settings → Rules → New branch ruleset), for `main` and `develop`:

- Require a pull request before merging (at least 1 approval for `main`).
- Require status checks: `web · lint, test, build, audit`, `go · fmt, vet, lint, test, vulncheck`,
  `migrations · up, down, up on PostGIS`, `security · secrets, IaC, scripts, deps`,
  `image · build, scan, push` (they appear in the list after the first run).
- Block force pushes and deletions.

**Step 5: The develop branch**: created from `main` on the first push.

**Step 6: After the first image push**: Packages → `samad` → Package settings:
check that `OGC-Ltd/samad` is listed under *Manage Actions access* (it is when
the workflow created the package). Keep the package private.

---

## 11. Day-to-day: shipping a change

1. **Branch** from `develop`:
   ```bash
   git switch develop && git pull && git switch -c feature/<name>
   ```
2. **Check locally** before pushing (the same checks CI runs):
   ```bash
   npx eslint . --max-warnings=0 && npx vitest run && npm run build
   cd server && gofmt -l . && go vet ./... && golangci-lint run ./... && go test ./... && govulncheck ./...
   ```
3. **Open a pull request into `develop`.** The pipeline runs every check and
   builds the image. Fix anything red; merge when green and reviewed.
4. **The merge deploys to dev** on its own. Watch Actions → pipeline →
   *deploy · dev*; then check `https://dev.13-247-156-214.sslip.io`.
5. **Promote**: open a pull request from `develop` into `main`. Merge it.
6. **Approve the production deploy**: Actions → the run → *Review deployments*
   → `production` → Approve. The image is deployed by digest, with a database
   backup first.
7. **Verify**: the deploy job's summary shows the running image and schema
   version; open the site.

Hotfix: branch from `main`, pull request into `main`, then merge `main` back
into `develop`.

---

## 12. Deploying, rolling back, checking by hand

### 12.1 What a deploy does (`deploy/deploy.sh`)

1. Checks the bundle (only `docker-compose.yml`, `server/migrations/*.sql`,
   `.ghcr-token`; at most 5 MB; no links) and the image
   (`ghcr.io/ogc-ltd/samad@sha256:<64 hex>`).
2. Logs in to GHCR with the job's short-lived token, pulls, logs out.
3. Production: `pg_dump` to `backups/pre-deploy-<time>.dump` (last 10 kept).
4. Saves the running release to `releases/<time>/` (last 5 kept).
5. Installs the new compose file and migrations, sets `SAMAD_IMAGE`.
6. `docker compose up -d --wait`: migrations, then a healthy app (3 min limit).
7. Asks `https://<domain>/api/v1/health` through Traefik (60 s).
8. If 6 or 7 fails: puts the saved compose file and image back, and fails the job.

One deploy per stack at a time (a lock on the box, and a GitHub concurrency group).

### 12.2 From GitHub

Actions → **deploy** → Run workflow:

| Stack | Action | Image |
| --- | --- | --- |
| `dev` / `prod` | `deploy` | `ghcr.io/ogc-ltd/samad@sha256:…` (from the image job's summary or Packages) |
| `dev` / `prod` | `rollback` | — back to the previous release |
| `dev` / `prod` | `status` | — image, containers, schema version |

A `prod` run waits for the production approval like any other.

### 12.3 On the box

```bash
sudo -u deploy samad-deploy status prod
sudo -u deploy samad-deploy rollback prod
ls /opt/samad/releases/                       # what can be rolled back to
```

---

## 13. Backups and restoring

- **Automatic**: every production deploy dumps the database first
  (`/opt/samad/backups/pre-deploy-*.dump`, custom format, last 10).
- **By hand**:
  ```bash
  cd /opt/samad
  sudo -u deploy sh -c 'umask 027; mkdir -p backups; docker compose exec -T db pg_dump -U samad -d samad -Fc > backups/manual-$(date -u +%Y%m%dT%H%M%SZ).dump'
  ```
- **Restore** (stops the app so nothing writes meanwhile):
  ```bash
  cd /opt/samad
  sudo -u deploy docker compose stop samad
  sudo -u deploy sh -c 'docker compose exec -T db pg_restore -U samad -d samad --clean --if-exists < backups/<file>.dump'
  sudo -u deploy docker compose start samad
  ```
- **Off the box**: the dumps live on the same disk as the database. Copy them
  elsewhere (S3, or `scp` to a workstation) on a schedule; a lost instance
  loses its dumps too ([§18](#18-open-items)).
- **The app's state file** (`state.json`, alerts, read marks, decisions) is in
  the `samad-data` volume:
  ```bash
  docker run --rm -v samad-data:/d -v "$PWD":/b busybox tar -czf /b/samad-data.tgz -C /d .
  ```

---

## 14. Moving to the real domain

1. **DNS**: an `A` record for the domain (e.g. `fleet.samadresources.com`) → `13.247.156.214`.
   Optionally `dev.fleet.…` for dev. Wait until `dig +short <domain>` answers the IP.
2. **Stack setting**: in `/opt/samad/.env` set `SAMAD_DOMAIN=<domain>`, then:
   ```bash
   cd /opt/samad && sudo -u deploy docker compose up -d --wait
   ```
   Traefik requests the certificate on the first visit.
3. **GitHub**: update `SAMAD_URL` in the `production` environment.
4. **Google Maps key**: add the new domain to its allowed referrers.
5. **HSTS**: the site sends `Strict-Transport-Security` for a year, so the
   domain must stay on HTTPS.
6. Retire the sslip.io name whenever convenient (remove it from the key's
   referrers).

---

## 15. Logs, health and troubleshooting

| What | Command (on the box) |
| --- | --- |
| Everything running | `docker ps --format 'table {{.Names}}\t{{.Status}}'` |
| App log | `cd /opt/samad && sudo -u deploy docker compose logs -f --tail 100 samad` |
| Migrations of the last start | `sudo -u deploy docker compose logs migrate` |
| Database log | `sudo -u deploy docker compose logs --tail 100 db` |
| Traefik log (access + errors) | `docker logs -f --tail 100 traefik` |
| Health through Traefik | `curl -s https://13-247-156-214.sslip.io/api/v1/health` |
| Memory, CPU | `free -h; docker stats --no-stream` |
| Disk | `df -h /; docker system df` |

Logs rotate at 10 MB × 3 per container.

**Common problems**

| Symptom | Likely cause | Do |
| --- | --- | --- |
| `variable is not set` warning, sign-in fails | a `$` in `server/.env` unquoted (bcrypt hash) | wrap the value in single quotes |
| `migrate` exits non-zero, app does not start | bad SQL, or a **dirty** version | `docker compose logs migrate`; fix; `migrate force <version>` |
| `database "samad" does not exist` on a new stack | the database volume was initialised wrongly | stop the stack, `docker volume rm <stack>-pgdata` (only on an empty stack!), start again |
| 404 from Traefik for the domain | container unhealthy or not on `proxy` | `docker compose ps`; check the labels with `docker inspect <stack>` |
| Browser certificate warning | DNS not pointing at the box yet, or port 80 blocked | check DNS and the security group; `docker logs traefik \| grep -i acme` |
| Map tiles, fonts or Google layers blank | the Content Security Policy blocks a new host | add the host to the CSP label in `docker-compose.yml` |
| Fleet summary says "AI unavailable" | no OpenAI key, or the account has no credits | add credits; `docker compose logs samad \| grep "ai insight"` |
| Deploy job: `Permission denied (publickey)` | `SAMAD_DEPLOY_KEY` missing or wrong | re-paste `keys/samad-deploy` |
| Deploy job: `Host key verification failed` | `SAMAD_DEPLOY_KNOWN_HOSTS` missing, or the box was rebuilt | `ssh-keyscan -t ed25519 <host>` and update the secret |
| Deploy job: `denied` pulling the image | the package lacks Actions access for the repo | §10 step 6 |
| Deploy job: `another deploy … is running` | a deploy still running (or one killed mid-way) | wait; a lock left by a killed run frees itself when its process ends |

---

## 16. Security measures in place

**Network**
- Only 80/443 (Traefik) face the internet; Traefik's dashboard is on localhost.
- Databases are on internal networks with no internet and no published port.
- Dev and production cannot reach each other's databases.

**Containers**
- The app: distroless, non-root (65532), read-only root filesystem, `/tmp` tmpfs,
  every Linux capability dropped, `no-new-privileges`, memory/CPU/process limits.
- The database: only the five capabilities its entrypoint needs, `no-new-privileges`, limits.
- `migrate`: non-root, read-only, no capabilities.

**HTTP** (Traefik middleware)
- HTTPS only, HSTS one year; HTTP redirects.
- Content Security Policy listing only the hosts the app uses; `frame-ancestors 'none'`.
- `nosniff`, `X-Frame-Options: DENY`, strict referrer, permissions policy, COOP, `noindex`.
- Sign-in and refresh rate-limited per address (10/min, burst 5).
- Request headers that imitate Traefik's are removed.

**Application**
- Refresh cookie: HttpOnly, SameSite=Lax, Secure over HTTPS, scoped to `/api/v1`.
- Tokens: HMAC-signed, 15-minute access tokens; tampered, expired, wrong-type
  and foreign-signed tokens are refused (tested).
- Static files through `os.Root`: no path, symlink or `..` escapes (tested).
- Missing files, hidden folders and `/api/*` outside the API are 404s.
- Log lines quote the request path, so it cannot forge entries.
- Dashcam clips go through the server's own route, signed in; the video host's
  URLs never reach the browser.
- Every organisation route refuses any organisation but Samad's (tested).

**Pipeline**
- Secrets scanned in every commit; dependencies, image and config scanned on every change.
- Actions pinned by SHA; scanners pinned by image; minimal token permissions.
- Production needs an approval and deploys by digest.
- CI's key can only run the deploy script; the box keeps no registry credentials.

---

## 17. Rebuilding the box from nothing

1. Launch Ubuntu 26.04 (x86_64) in `af-south-1`, with the `samad` key pair and a
   security group allowing 22 (from your addresses), 80 and 443.
2. [§3](#3-preparing-the-server): Go, Docker, swap, the `admin` user.
3. [§4](#4-traefik-the-front-door): Traefik from `deploy/traefik/`.
4. [§9.4](#94-the-deploy-user-and-its-forced-command): the `deploy` user, its key, `samad-deploy`.
5. [§6.3](#63-setting-up-a-stack-folder): `/opt/samad` and `/opt/samad-dev`.
6. Restore the latest database dump ([§13](#13-backups-and-restoring)) after the first deploy has created the database.
7. Update the GitHub secret `SAMAD_DEPLOY_KNOWN_HOSTS` (new host key) and, if
   the address changed, `SAMAD_DEPLOY_HOST`, DNS and `SAMAD_DOMAIN`.
8. Run Actions → deploy → `deploy` for each stack (or push to `develop`/`main`).

---

## 18. Open items

| Item | Why it matters | Next step |
| --- | --- | --- |
| The server still stores its state in `state.json` | the PostGIS schema is ready but unused | move the store (events, decisions, reads, day tallies, positions) onto the tables |
| Backups stay on the box | a lost instance loses its dumps | a nightly `pg_dump` copied to S3 (or similar), and a tested restore |
| OpenAI account has no credits | the Fleet summary falls back to facts | add credits on platform.openai.com |
| Google Maps key unrestricted | anyone can use it on your bill | restrict by referrer and API (§8) |
| Keys pasted in chat | they may be exposed | rotate the OpenAI and Maps keys, update where §8 says |
| Real domain | sslip.io names are a stopgap | §14 |
| `/opt/samad` still holds an old copy of the source | left from the first manual deploy, unused | delete everything there except `.env`, `server/.env`, `secrets/`, `releases/`, `backups/` after the first CI deploy |
| Partner `/trips` is 403 | trips and km are worked out from positions | ask IntelliFleet360 to enable it for the key |
| Speed limit for overspeeding is a guess (65 km/h) | alerts may not match the partner's own | set `SPEED_LIMIT_KMH` once known |
| Monitoring and alerting | nobody is told when the site is down | an uptime check on `/api/v1/health` (e.g. UptimeRobot) and disk/memory alarms in CloudWatch |
| Single box | an instance failure is an outage | acceptable for now; snapshots of the EBS volume as a cheap safety net |
