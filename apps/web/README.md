# Dashboard (dev contour)

Functional dispatcher day screen: engineer list, MapLibre routes, per-engineer
timeline, request reasons, and a replan delta. Layout follows the current
designer frame; visual polish is intentionally later.

```bash
pnpm --filter web dev
```

Open http://127.0.0.1:5173

Data is a typed fixture (`src/fixtures/dev-day.ts`) shaped like
`apps/api` dispatch views. Set `VITE_API_BASE` later to point at sys.
