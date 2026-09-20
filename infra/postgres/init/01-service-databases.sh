#!/bin/sh
# Creates, for each financial service, ONE database and TWO login roles (ADR-0032, least privilege):
#   <svc>_migrator  owns the database and its schema; used ONLY by the explicit migration step (DDL).
#   <svc>_app       the runtime role: CONNECT to its own database, DML on tables the migrator creates, nothing else.
# No role is a superuser. Every role is barred from every other service's database. Runs once, on an empty data volume.
set -eu

valid() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_.-]{8,}$'; }

create_service() {
  svc=$1; mig_pw=$2; app_pw=$3
  valid "$mig_pw" && valid "$app_pw" || { echo "init: passwords for $svc must be 8+ characters of [A-Za-z0-9_.-]" >&2; exit 1; }

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE ${svc}_migrator LOGIN PASSWORD '${mig_pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE ${svc}_app      LOGIN PASSWORD '${app_pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE ${svc} OWNER ${svc}_migrator;
REVOKE ALL ON DATABASE ${svc} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${svc} TO ${svc}_app;
SQL

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$svc" <<SQL
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO ${svc}_migrator;
GRANT USAGE ON SCHEMA public TO ${svc}_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ${svc}_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${svc}_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ${svc}_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${svc}_app;
SQL
  echo "init: database and roles created for $svc"
}

create_service auth       "${AUTH_MIGRATOR_PASSWORD:-}"       "${AUTH_APP_PASSWORD:-}"
create_service billing    "${BILLING_MIGRATOR_PASSWORD:-}"    "${BILLING_APP_PASSWORD:-}"
create_service payment    "${PAYMENT_MIGRATOR_PASSWORD:-}"    "${PAYMENT_APP_PASSWORD:-}"
create_service accounting "${ACCOUNTING_MIGRATOR_PASSWORD:-}" "${ACCOUNTING_APP_PASSWORD:-}"
