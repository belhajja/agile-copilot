#!/bin/sh
# End-to-end check of the operator on a real Docker daemon: install, upgrade, a failed upgrade
# rolled back, backup and restore. Images are re-tagged into a local registry (localhost:5000) as
# versions v0.0.1, v0.0.2 and a broken v0.0.3 (its migrate exits 1), so pulls are real.
# Usage: run.sh <registry image base> <ref slug>   (needs docker; DOCKER_HOST may be remote)
# Run it on a throwaway daemon (CI's docker:dind): the stack uses the compose project
# agile-copilot, and the script refuses to start if anything of that project already exists.
set -eu
BASE=$1
SLUG=$2
LOCAL=localhost:5000/agile
OP="$BASE/operator/snapshot:$SLUG"
PROJECT=com.docker.compose.project=agile-copilot

existing="$(docker ps -aq --filter "label=$PROJECT")$(docker volume ls -q --filter "label=$PROJECT")"
existing="$existing$(docker network ls -q --filter "label=$PROJECT")"
if [ -n "$existing" ] || docker container inspect opit-registry >/dev/null 2>&1 ||
  docker volume inspect opit-data >/dev/null 2>&1; then
  echo 'this daemon already has an agile-copilot stack, opit-registry or opit-data: refusing to run' >&2
  exit 1
fi

cleanup() {
  docker ps -aq --filter "label=$PROJECT" | xargs -r docker rm -f -v >/dev/null
  docker volume ls -q --filter "label=$PROJECT" | xargs -r docker volume rm >/dev/null
  docker network ls -q --filter "label=$PROJECT" | xargs -r docker network rm >/dev/null
  docker rm -f -v opit-registry >/dev/null 2>&1 || true
  docker volume rm opit-data >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Pulled only when missing, so a run can use images loaded beforehand.
fetch() { docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null; }

docker run -d --name opit-registry -p 5000:5000 registry:2 >/dev/null
for svc in web worker migrate; do
  fetch "$BASE/$svc/snapshot:$SLUG"
  for v in v0.0.1 v0.0.2 v0.0.3; do
    docker tag "$BASE/$svc/snapshot:$SLUG" "$LOCAL/$svc:$v"
  done
done
printf 'FROM alpine:3.24\nCMD ["false"]\n' | docker build -q -t "$LOCAL/migrate:v0.0.3" - >/dev/null
for svc in web worker migrate; do
  for v in v0.0.1 v0.0.2 v0.0.3; do docker push -q "$LOCAL/$svc:$v" >/dev/null; done
done
fetch "$OP"
# The updater service runs the operator image of the installed version.
for v in v0.0.1 v0.0.2 v0.0.3; do
  docker tag "$OP" "$LOCAL/operator:$v"
  docker push -q "$LOCAL/operator:$v" >/dev/null
done

op() {
  version=$1
  shift
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v opit-data:/data \
    -e OPERATOR_VERSION="$version" -e OPERATOR_IMAGE_BASE="$LOCAL" "$OP" "$@"
}
sql() { docker exec agile-copilot-postgres-1 psql -U agile -d agile -tAc "$1"; }
healthy() { docker exec agile-copilot-web-1 wget -qO- http://127.0.0.1:3000/healthz >/dev/null; }

echo '--- install v0.0.1'
op v0.0.1 install --yes --mode local --port 3000
healthy
# The updater runs, on the operator image of the installed version.
test "$(docker inspect -f '{{.State.Running}} {{.Config.Image}}' agile-copilot-updater-1)" = "true $LOCAL/operator:v0.0.1"
sql "create table it_marker (v text); insert into it_marker values ('kept')"

echo '--- upgrade to v0.0.2'
op v0.0.2 upgrade
healthy
test "$(sql 'select v from it_marker')" = kept
# Captured first: `op ... | grep -q` would close the pipe on the operator mid-output.
st=$(op v0.0.2 status)
echo "$st" | grep -q '^Version  v0.0.2 (local)$'
echo "$st" | grep -q '^Upgrade  v0.0.1 → v0.0.2: ok '

echo '--- upgrade to the broken v0.0.3 rolls back'
if op v0.0.3 upgrade; then
  echo 'the broken upgrade succeeded' >&2
  exit 1
fi
healthy
test "$(sql 'select v from it_marker')" = kept
st=$(op v0.0.3 status)
echo "$st" | grep -q '^Version  v0.0.2 (local)$'
echo "$st" | grep -q '^Upgrade  v0.0.2 → v0.0.3: rolled_back '

echo '--- backup and restore'
out=$(op v0.0.2 backup)
echo "$out"
backup=${out#✓ backup }
sql 'delete from it_marker'
out=$(op v0.0.2 restore latest --yes)
echo "$out"
# `latest` is the backup just taken, not the safety backup the restore takes first.
echo "$out" | grep -q "^✓ restored $backup (v0.0.2)$"
test "$(sql 'select v from it_marker')" = kept
healthy
echo 'operator integration: ok'
