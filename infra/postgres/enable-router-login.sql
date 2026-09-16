-- Compose-only login for Router Core. The migration owns permissions; this script only
-- supplies credentials from the environment without committing them to schema history.
SELECT format('ALTER ROLE router_readonly WITH LOGIN PASSWORD %L', :'router_password')
\gexec
