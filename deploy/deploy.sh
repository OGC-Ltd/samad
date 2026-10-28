#!/usr/bin/env bash
# samad-deploy: the only thing CI's SSH key may run on the box.
#
# Installed as /usr/local/bin/samad-deploy (root-owned) and bound to the
# deploy user's key with a forced command:
#
#   restrict,command="/usr/local/bin/samad-deploy" ssh-ed25519 AAAA… github-actions
#
# so whatever CI asks for arrives in SSH_ORIGINAL_COMMAND and nothing else
# runs. Commands:
#
#   deploy   prod <image>   stdin: a tar.gz of the release files (below)
#   rollback prod           back to the previous release
#   status   prod
#
# The release bundle holds exactly: docker-compose.yml, server/migrations/*.sql
# and .ghcr-token (a short-lived GitHub token, used to pull the image, then
# dropped), and optionally .google-keys (GOOGLE_MAPS_API_KEY= and
# GOOGLE_ROUTING_API_KEY= lines from the GitHub production environment,
# written into server/.env so no key is ever in the image). <image> must be
# ghcr.io/ogc-ltd/samad pinned by digest.
#
# A deploy: unpack and check the bundle → pull the image → (prod) back up the
# database → install the files, point .env at the image → `compose up --wait`
# (migrations run first, the app must turn healthy) → health check through
# Traefik. Any failure puts the previous release back.

set -Eeuo pipefail
umask 027

IMAGE_RE='^ghcr\.io/ogc-ltd/samad@sha256:[0-9a-f]{64}$'
KEEP_RELEASES=5
KEEP_BACKUPS=10

log() { printf '[samad-deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Split the forced command into words, with globbing off so a "*" stays a "*".
set -f
# shellcheck disable=SC2086 # word splitting is the point here
set -- ${SSH_ORIGINAL_COMMAND:-$*}
set +f
action=${1:-}; envname=${2:-}; image=${3:-}

case "$envname" in
  prod) dir=/opt/samad ;;
  *)    die "usage: deploy prod <image> | rollback prod | status prod" ;;
esac
[ -f "$dir/.env" ] || die "$dir/.env missing: the stack is not set up"
cd "$dir"

# One deploy per stack at a time.
exec 9>"$dir/.deploy.lock"
flock -n 9 || die "another deploy of $envname is running"

envget() { sed -n "s/^$1=//p" .env | tail -1; }
# envset KEY VALUE [FILE]: the stack's .env unless another file is named.
envset() {
  local k=$1 v=$2 f=${3:-.env}
  if grep -q "^$k=" "$f"; then sed -i "s|^$k=.*|$k=$v|" "$f"; else printf '%s=%s\n' "$k" "$v" >> "$f"; fi
}

# Through Traefik, as a browser would, but without leaving the box.
smoke() {
  local domain; domain=$(envget SAMAD_DOMAIN)
  for _ in $(seq 1 20); do
    if curl -fsS -m 5 --resolve "$domain:443:127.0.0.1" "https://$domain/api/v1/health" | grep -q '"ok":true'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

up() { docker compose up -d --remove-orphans --wait --wait-timeout 180; }

# Names under <dir> matching <glob>, oldest first (they are UTC timestamps).
# A folder that does not exist yet lists nothing.
listed() { [ -d "$1" ] || return 0; find "$1" -mindepth 1 -maxdepth 1 -name "$2" -print0 | sort -z; }
# Delete all but the newest <n>.
keep_newest() { listed "$1" "$2" | head -z -n -"$3" | xargs -0 -r rm -rf; }

# releases/<n>/ keeps each release's compose file, migrations and image.
save_current() {
  [ -f docker-compose.yml ] || return 0
  local r
  r="releases/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$r/server"
  cp docker-compose.yml "$r/"
  cp -r server/migrations "$r/server/" 2>/dev/null || true
  envget SAMAD_IMAGE > "$r/image"
  keep_newest releases '[0-9]*Z' "$KEEP_RELEASES"
  echo "$r"
}

# Back to a saved release's compose file and image. The migrations folder
# is left as it is: migrations are only ever added, so the current folder
# holds every file the database has seen, and migrate's `up` is then a
# no-op. (Putting the old folder back would leave the database on a version
# migrate cannot find, and the app would not start.) A migration must
# therefore keep the previous release working: add, then remove later.
restore() {
  local r=$1
  log "restoring $r"
  cp "$r/docker-compose.yml" docker-compose.yml
  envset SAMAD_IMAGE "$(cat "$r/image")"
  up
}

case "$action" in
status)
  echo "stack:  $(envget STACK)"
  echo "domain: $(envget SAMAD_DOMAIN)"
  echo "image:  $(envget SAMAD_IMAGE)"
  docker compose ps --format 'table {{.Name}}\t{{.Status}}'
  docker compose run --rm -T migrate version 2>&1 | tail -1 | sed 's/^/schema: /'
  ;;

rollback)
  prev=$(listed releases '[0-9]*Z' | tr '\0' '\n' | tail -1)
  [ -n "$prev" ] || die "no earlier release to go back to"
  restore "$prev"
  smoke || die "rolled back, but the health check still fails"
  rm -rf "$prev"
  log "rolled back to $(envget SAMAD_IMAGE)"
  ;;

deploy)
  [[ "$image" =~ $IMAGE_RE ]] || die "image must be ghcr.io/ogc-ltd/samad@sha256:<digest>, got '$image'"

  stage=$(mktemp -d)
  cleanup() { rm -rf "$stage"; docker logout ghcr.io >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  # The bundle: at most 5 MB, only the expected names, no links or ..
  head -c 5242880 | tar -xz -C "$stage" --no-same-owner --no-same-permissions
  bad=$(cd "$stage" && find . -mindepth 1 \( -type l -o -type b -o -type c -o -type p \) -print -o -type f -print \
        | grep -vE '^\./(docker-compose\.yml|\.ghcr-token|\.google-keys|server/migrations/[0-9]{6}_[a-z0-9_]+\.(up|down)\.sql)$' || true)
  [ -z "$bad" ] || die "unexpected files in the bundle: $bad"
  [ -s "$stage/docker-compose.yml" ] || die "bundle has no docker-compose.yml"
  [ -s "$stage/.ghcr-token" ] || die "bundle has no registry token"
  # Google keys: only these two names, only key characters, nothing else.
  if [ -e "$stage/.google-keys" ]; then
    grep -vqE '^GOOGLE_(MAPS|ROUTING)_API_KEY=[A-Za-z0-9_-]{20,100}$' "$stage/.google-keys" \
      && die ".google-keys holds something other than GOOGLE_MAPS_API_KEY / GOOGLE_ROUTING_API_KEY lines"
  fi

  log "pulling $image"
  docker login ghcr.io -u github-actions --password-stdin < "$stage/.ghcr-token" >/dev/null
  rm -f "$stage/.ghcr-token"
  docker pull -q "$image" >/dev/null
  docker logout ghcr.io >/dev/null

  if [ "$envname" = prod ] && docker compose ps --status running --services 2>/dev/null | grep -qx db; then
    install -d -m 750 backups
    b="backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
    log "backing up the database to $dir/$b"
    docker compose exec -T db pg_dump -U samad -d samad -Fc > "$b"
    keep_newest backups 'pre-deploy-*.dump' "$KEEP_BACKUPS"
  fi

  prev=$(save_current)
  install -m 640 "$stage/docker-compose.yml" docker-compose.yml
  rm -rf server/migrations && mkdir -p server && cp -r "$stage/server/migrations" server/migrations
  # Readable by migrate (uid 65532, not in our group); they are in git, not secret.
  chmod -R u=rwX,go=rX server/migrations
  envset SAMAD_IMAGE "$image"
  if [ -e "$stage/.google-keys" ]; then
    while IFS='=' read -r k v; do
      envset "$k" "$v" server/.env
    done < "$stage/.google-keys"
    log "Google keys written to server/.env"
  fi

  log "starting $image (migrations first)"
  if up && smoke; then
    log "deployed $envname: $image"
    docker image prune -f >/dev/null || true
  else
    log "deploy failed"
    docker compose logs --tail 40 samad migrate >&2 || true
    if [ -n "$prev" ]; then
      restore "$prev" && smoke && log "back on the previous release"
    fi
    die "deploy of $image to $envname failed"
  fi
  ;;

*)
  die "unknown command '$action'"
  ;;
esac
