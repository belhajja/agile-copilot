#!/bin/sh
# Creates the non-owner role the app connects as, so Postgres row-level security applies to it.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE app_user LOGIN PASSWORD '${APP_DB_PASSWORD}';
  GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO app_user;
  GRANT USAGE ON SCHEMA public TO app_user;
EOSQL
