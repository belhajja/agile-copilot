#!/bin/sh
# Updates the stack to the images in .env: pulls them, stops web and worker, backs up the database
# to backups/, runs the migrations, then starts everything. If the migrations fail, web and worker
# stay stopped and the restore commands are printed. Run it from anywhere: ./update.sh
# (update.ps1 does the same on Windows.)
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo "No .env next to docker-compose.yml: copy .env.example first." >&2; exit 1; }

backup="backups/agile-$(date +%Y%m%d-%H%M%S).dump"
mkdir -p backups

echo "==> Pulling the images"
docker compose pull

echo "==> Stopping web and worker"
docker compose stop web worker

echo "==> Backing up the database to deploy/compose/$backup"
docker compose up -d --wait postgres
docker compose exec -T postgres pg_dump -U agile -d agile -Fc > "$backup"
[ -s "$backup" ] || { echo "The backup is empty: stopping here (nothing was migrated)." >&2; exit 1; }

echo "==> Running the migrations"
attempt=1
until docker compose run --rm --no-deps migrate; do
  if [ "$attempt" -ge 3 ]; then
    cat >&2 <<EOF

The migrations failed (3 attempts). web and worker are stopped. To go back to the backup, in
$(pwd):
  1. In .env, set WEB_IMAGE, WORKER_IMAGE and MIGRATE_IMAGE back to the previous release.
  2. docker compose exec -T postgres dropdb -U agile --force agile
     docker compose exec -T postgres pg_restore -U agile -d postgres --create --exit-on-error < $backup
  3. docker compose up -d
EOF
    exit 1
  fi
  attempt=$((attempt + 1))
  echo "Migrations failed, retrying in 5 s (attempt $attempt of 3)"
  sleep 5
done

echo "==> Starting the stack"
docker compose up -d
docker compose ps
echo "Done. Backup: deploy/compose/$backup"
