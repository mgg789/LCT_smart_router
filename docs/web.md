# Web — dispatcher dashboard (dev contour)

> Living notes for `apps/web`. The screen is a working stand-in until the
> designer/frontend pass replaces the chrome. Types stay aligned with sys views.

## What is on screen

The only implemented page is the dispatcher day:

- engineer list with distance, shift and done/assigned counts
- MapLibre map (CARTO Voyager fallback, `context/27` §4) with per-engineer routes
- horizontal route timeline for the selected engineer
- request panel with structured “why this engineer” factors (`context/11` §3)
- unassigned banner (skill-blocked jobs stay visible)
- policy modal (catalog + lunch switch). Lunch is off by default
  (`lunches_enabled=false`, context/50 §3). AUTO rebuilds on apply; there is
  no separate “rebuild” button. A delta card still appears after a change

## Data

Absolute times are Unix seconds. The fixture `createDevSnapshot()` mirrors:

| UI | sys |
|---|---|
| Day list / request panel | `GET /api/v1/dispatch/requests` → `RequestView` |
| Engineer column | `GET /api/v1/dispatch/engineers` → `EngineerView` + `EngineerDayView` |
| Map, timeline, reasons | `GET /api/v1/dispatch/plan` → `PlanView` |
| Unassigned / alerts | `GET /api/v1/dispatch/alerts` |
| Policy labels | `GET /api/v1/dispatch/policies` |

Live HTTP is not wired yet. Changing policy or the lunch switch locally swaps
fixture plans so the automatic-replan delta can be reviewed without Router. The
map starts on one engineer; close (×) on the request panel, “Все маршруты”, or
a second click on the selected engineer returns the day overview with every
route. A traveling master lights the whole planned edge — never a point on
that edge (no GPS).

## Missing contracts the UI already expects

- SSE / poll of `plan.updated` while “Перестраивается”
- Accept/reject of a pending result (today the working plan is applied by sys)
- Dashboard lunch switch → sys technical setting `lunches_enabled` (Router-owned;
  no dispatch DTO yet). The modal already sends the boolean with the policy
- Dispatcher AI chat (`read-only` / `fix`) — button is disabled on purpose
- MANUAL reassign / reorder endpoints exist (`POST /dispatch/plan/reassign`,
  `reorder`); the screen only toggles the mode badge
