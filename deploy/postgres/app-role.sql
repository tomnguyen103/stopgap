-- The NON-SUPERUSER application role (PHASE6 §6.5).
--
-- WHY THIS FILE EXISTS. Migration 0013 installs a row-level security policy on every tenant table
-- and marks each `FORCE ROW LEVEL SECURITY`. None of that applies to a SUPERUSER — a superuser
-- bypasses every policy unconditionally, and `FORCE` only removes the table OWNER's exemption, not
-- the superuser's. The `postgres:16-alpine` image creates its `POSTGRES_USER` (`stopgap`) as a
-- superuser, so a stack whose application connects as that role has the policies installed and
-- enforcing nothing: an application bug that loses its org filter returns another hospital's rows,
-- every test still passes, and nothing anywhere reports a problem.
--
-- So the shipped stacks create a plain role for the application to connect as, rather than
-- documenting the superuser problem and leaving the operator to fix it. This script is run by a
-- one-shot `app-role-init` service in both compose files, BEFORE migrations, on every `up`. It is
-- idempotent and runs against an existing volume — unlike `/docker-entrypoint-initdb.d`, which only
-- executes on a first boot with an empty data directory and would therefore silently skip every
-- stack that already has data in it.
--
-- Invoked as:  psql -v app_pw="…" -v owner=stopgap -f app-role.sql
-- `:'app_pw'` is psql's quote-as-a-literal substitution, so a password containing a quote is
-- escaped by psql rather than concatenated into the statement.

-- CREATE ROLE has no IF NOT EXISTS, hence the DO block. Note what is NOT granted: no SUPERUSER,
-- no BYPASSRLS, no CREATEDB, no CREATEROLE. Those absences are the entire security property.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stopgap_app') THEN
    CREATE ROLE stopgap_app LOGIN;
  END IF;
END
$$;

-- Re-asserted on every run rather than only at creation: an operator who rotates the password in
-- the env file gets it applied, and a role that somehow acquired SUPERUSER/BYPASSRLS is stripped of
-- it. The whole point of this role is what it may NOT do, so that is stated explicitly every time.
ALTER ROLE stopgap_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';

-- USAGE ON SCHEMA is not optional and is the step most hand-written recipes forget: without it the
-- role cannot NAME any object in `public`, and every query fails with "permission denied for schema
-- public" regardless of the table grants below.
GRANT USAGE ON SCHEMA public TO stopgap_app;

-- Tables that already exist. The four DML verbs the application actually issues, and NOT `ALL`.
--
-- TRUNCATE IS THE ONE THAT MATTERS, and it is excluded on purpose: TRUNCATE is not row-level DML
-- and ROW-LEVEL SECURITY DOES NOT APPLY TO IT. A policy filters the rows a DELETE may see; TRUNCATE
-- removes the whole table regardless of `app.current_org`, of `USING`, and of `FORCE`. So a role
-- holding TRUNCATE can erase EVERY tenant's cases, protocols and audit chain in one statement while
-- every policy installed by 0013 is enforcing perfectly — the isolation guarantee this file exists
-- to establish, bypassed by the single verb `ALL` quietly includes. The application never truncates
-- anything, so nothing is lost by withholding it.
--
-- REFERENCES and TRIGGER go with it for the ordinary reason: the app creates no tables, so it needs
-- neither, and a grant nobody uses is only an escalation path nobody is watching.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stopgap_app;
-- Sequences: `USAGE` (nextval, for the `bigserial` keys) and `SELECT` (currval), never `UPDATE` —
-- which is `setval`, i.e. the ability to rewind `audit_log.id` and make a later append collide with
-- or overwrite an existing row's place in the chain.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stopgap_app;

-- Tables that DO NOT EXIST YET. Grants are per-object and are not inherited by later `CREATE
-- TABLE`s, so without this every future migration ships a table the application cannot read — the
-- failure appearing one deploy after the change that caused it. `FOR ROLE :owner` matters: default
-- privileges attach to the role that CREATES the object, and migrations run as the owner
-- (`stopgap`), never as `stopgap_app`, which holds no CREATE right on the schema.
--
-- The verb list mirrors the direct grants above EXACTLY, and must keep mirroring them. A default
-- privilege that said `ALL` would hand TRUNCATE back on every table a future migration creates —
-- the RLS bypass closed above, reopened one deploy later on the newest tables, which are the ones
-- least likely to be re-audited.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stopgap_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stopgap_app;
