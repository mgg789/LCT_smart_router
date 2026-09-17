# Web — dispatcher dashboard

> Living notes for `apps/web`. Types stay aligned with sys views.

## What is on screen

Dispatcher day, policy comparison and engineer roster:

- engineer list, unassigned jobs, MapLibre map, route timeline
- request panel with structured “why this engineer” factors (`context/11` §3)
- policy modal (catalog + lunch switch). Lunch is off by default
  (`lunches_enabled=false`, context/50 §3)
- header control mode is a real AUTO/MANUAL toggle (`POST /dispatch/mode`)
- UI copy is Russian; solver English evidence is translated by reason code

## Data

Absolute times are Unix seconds. Live HTTP goes through `apps/web/src/api/client.ts`:

| UI | sys |
|---|---|
| Day list / request panel | `GET /api/v1/dispatch/requests` → `RequestView` |
| Engineer column | `GET /api/v1/dispatch/engineers` → `EngineerView` + `EngineerDayView` |
| Map, timeline, reasons | `GET /api/v1/dispatch/plan` → `PlanView` |
| Unassigned / alerts | `GET /api/v1/dispatch/alerts` |
| Policy labels | `GET /api/v1/dispatch/policies` |
| Lunch switch | `GET/PUT /api/v1/dispatch/router/technical-settings` |

`VITE_API_BASE` is empty by default: Vite proxies `/api` to `127.0.0.1:8000`, and the
Docker image serves the same origin through nginx → `api:8000`.

## Docker

`pnpm compose:up` starts `web` with postgres, router and api. Open
<http://127.0.0.1:5173>. The container talks to `api` on the compose network; no
separate frontend env is required.

## Missing contracts the UI already expects

- SSE of `plan.updated` (today the client polls after a publication)
- Dispatcher AI chat (`read-only` / `fix`) — button is disabled on purpose
- MANUAL reassign / reorder endpoints exist; the screen toggles the mode
