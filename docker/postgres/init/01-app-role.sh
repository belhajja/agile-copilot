#!/bin/sh
# Creates the non-owner role the app connects as, so Postgres row-level security applies to it.
# The password and database name are psql variables, quoted by psql (:'pw', :"db"): any character
# is safe in them. The heredoc is quoted, so the shell expands nothing in the SQL.
set -e
psql -v ON_ERROR_STOP=1 -v pw="$APP_DB_PASSWORD" -v db="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
  CREATE ROLE app_user LOGIN PASSWORD :'pw';
  GRANT CONNECT ON DATABASE :"db" TO app_user;
  GRANT USAGE ON SCHEMA public TO app_user;
EOSQL
