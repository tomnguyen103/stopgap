# Compose expanded a container-time variable too early

## Problem

The production `demo-seed` service used a shell loop to run the nightly seed and measured shadow
replay only when demo mode was enabled. The first form placed `${STOPGAP_DEMO_MODE:-off}` directly
inside the Compose `entrypoint` string, which made the command depend on the host environment at
Compose-config time rather than the `STOPGAP_DEMO_MODE` value injected into the container.

## Root cause

Compose interpolates `${...}` expressions while it renders the service definition. The shell inside
the container never received the expression to evaluate, so a host without that variable rendered
the loop as `if [ "off" = "on" ]` even when the container environment was configured for demo mode.

## Fix and receipt

Escape the dollar sign as `$$` in `deploy/docker-compose.prod.yml:264`. Compose converts that to a
single dollar sign for the container shell, which then evaluates the runtime environment normally.
The service now runs the idempotent demo seed followed by the measured shadow replay whenever
`STOPGAP_DEMO_MODE=on` is present in the container.
