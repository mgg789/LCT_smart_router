# AGENTS.md — LCT Smart Router

Rules for any AI agent (Codex, Cursor, ZCode) and human contributor working in this repository.
Team language is Russian; **code, comments, identifiers, commits, PRs, and docs are written in English.**

## 0. Project Overview

**LCT Smart Router** — a web service for intelligent planning and live re-planning of field engineer
routes (Beeline Business case, LCT 2026 hackathon). The service distributes work orders across
engineers by qualification and availability, respects time windows, verifies transport and
equipment compatibility, minimizes travel time and SLA violations, re-plans the day automatically
when new requests arrive, and **explains why the plan looks the way it does** on a map.

Product strategy: **not** "many features" — a thought-through, coherent, beautiful tool
(Apple-like). Explainability is the core trust feature, not decoration.

| Link | What |
|---|---|
| https://github.com/mgg789/LCT_smart_router | This repository |
| https://task.droidje.com | **Main task board** (kan.bn, workspace `LCT`) — via `kan` MCP |
| `context/26-case-source.md` | Verbatim case statement (source of truth for requirements) |
| `context/00-README.md` | Full research context index (29 files) |
| `context/29-decision-log.md` | Accepted decisions (ADR), D-1…D-17 |
| `docs/` | Project documentation (see §8) |
| `docs/mcp-kanban.md` | How to connect/use the kanban MCP |

Stack (full rationale: `context/16`): pnpm monorepo — `apps/web` (React + TS + Vite + Tailwind +
MapLibre + framer-motion), `apps/api` (Fastify or FastAPI), `apps/solver` (Python + OR-Tools),
`packages/shared` (single source of contract types), PostgreSQL, docker-compose (`infra/`).

## 1. Sources of Truth (priority ladder)

1. Safety of the system, data, repository, and the demo environment
2. The user's direct request
3. This file
4. `context/29-decision-log.md` and the `context/` pack (do not re-open decided questions)
5. The kanban board (`kan` MCP) — the task source when the user gave no direct task
6. Other project files

If local standards already exist for components, layout, API layer, typing, styles, animations, or
structure — follow them strictly. Do not introduce a second way of doing the same thing.

## 2. Rule Priority (when in doubt)

1. Safety of system, data, and project boundaries
2. Correct execution of the actual task
3. A complete, working result consistent with the project
4. Adherence to architecture, contracts, and local standards
5. Minimal invasiveness of changes
6. Readability and maintainability

## 3. Scope of Work

1. Work only in the area your task belongs to (`apps/web`, `apps/api`, `apps/solver`,
   `packages/shared`, `infra/`, `data/`, `docs/`, `context/`).
2. Other areas are read-only — read them to understand contracts, dependencies, and integrations.
3. Modifying other areas is forbidden without a direct command.
4. `packages/shared` (contracts) is changed **only by the integration owner**. If you need a
   contract change — request it in the board card / to the owner; never edit it silently.
5. Server-side infrastructure (MGG server, nginx, DNS, secrets) is off-limits without an explicit
   user command. Server ops go through the `mgg-server-deploy` skill only.

## 4. General Execution Rules

1. Write only working, complete code — no placeholders, empty files, stubs, or fake logic unless
   explicitly requested.
2. Before changing anything, determine: the task, affected modules, existing patterns, and impact on
   adjacent scenarios.
3. **Reuse first**: search for existing components, styles, hooks, services, utilities, API layers,
   and design-system tokens; create new ones only when reuse is impossible.
4. Follow the existing architecture, code style, conventions, and structure exactly.
5. Do not touch unrelated parts of the codebase. Minimal sufficient diff — no drive-by refactoring.
6. Between a quick hack and a robust solution within task scope — choose the robust solution.
7. If a ticket or plan implies a weak, unsafe, or architecturally poor solution — do not silently
   comply; briefly object and propose a better engineering option.
8. If stuck for more than ~30 minutes, stop rabbit-holing: post a blocker comment on the board card
   and ask the human. Escalation is cheaper than a wrong solution.
9. All external calls (OSRM, 2GIS, data.mos.ru, Overpass, Open-Meteo, LLM) must be cached and must
   degrade gracefully — the demo contour must work **fully offline** (`context/15` §4).
10. Determinism is sacred: solver seeds are fixed; a change that alters the golden plan without
    explanation does not merge (`context/27` §10).

## 5. Branch Management

1. **`dev` is the default working branch.** All work happens in `dev`: start every session with
   `git checkout dev && git pull`, branch feature work off it, and merge back into it.
2. **`main` is protected and stays clean.** It is the demo-ready mirror ("stage = main" as its
   *state*): updated only by an explicit team-lead command via merge from `dev` when the smoke
   gate is green. Never commit or push to `main` directly; never force-push or rewrite its
   history. If you are not the team lead — your target is `dev`.
3. Branch naming: `feat/<area>-<slug>`, `fix/<area>-<slug>`, `chore/<slug>`, `docs/<slug>`,
   `refactor/<area>-<slug>` (e.g. `feat/solver-breaks`, `fix/web-timeline-dnd`). Branch off `dev`.
4. Do feature work on a short-lived branch; merge to `dev` only after the smoke gate is green.
5. Keep branches alive ≤ 1–2 days; rebase onto `dev` before merging; merge with a clear merge
   commit or fast-forward — no squash that hides checkpoints (the history is a demo artifact too).
6. One branch = one logical task (one board card). Do not mix unrelated work.
7. Contracts migration rule: if your branch requires a `packages/shared` change, coordinate first —
   the contracts owner applies it and you rebase.

## 6. Commits

Conventional Commits, imperative mood, English:

```
<type>(<scope>): <short imperative summary>

<optional body: why, what changed, side effects>
```

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
- **Scopes:** `web`, `api`, `solver`, `shared`, `infra`, `data`, `docs`, `context`.
- Examples: `feat(solver): add lunch-break intervals to routing model`,
  `fix(web): keep timeline scroll pinned to plan updates`,
  `docs(api): document /api/v1/plans endpoints`.

**Automatic commits at meaningful checkpoints are mandatory:**

1. Commit whenever a meaningful unit of work is complete **and green** (compiles, smoke not broken).
   "Green checkpoints only" — never leave uncommitted work that others can't build on, and never
   commit red code to a shared branch.
2. A "meaningful checkpoint" = a working increment a teammate could build on: a model constraint +
   its test, an API endpoint + its test, a UI component + its usage, a data migration + seed update.
3. Push the branch after every commit session; merge to `dev` per §5.
4. Commit messages explain **why**, not just what. If a commit changes the golden plan or metrics,
   state it in the body.
5. Never commit: secrets, tokens, `.env`, build artifacts, node_modules, OneDrive temp files.
   If a secret leaks — rotate it immediately and tell the user.

## 7. Working with Tasks (kan.bn via `kan` MCP)

1. If the user gave no direct task — go to the board: `list_workspaces` → workspace **LCT**
   (publicId `1kh73hl7xn3i`, slug `droidje`) → read the relevant board. Connection details:
   `docs/mcp-kanban.md`.
2. Take tasks in the card's priority order; **no more than 10 cards in progress per pass**.
3. Board state must always reflect reality: before starting work, move the card to *In Progress*
   (and comment "started: <branch name>"); when done — move to the done column and comment a
   2–5 line summary (what, where, how verified).
4. Card hygiene: a card must be understandable without chat context — goal, acceptance criteria,
   links to files/PRs. When creating a card, that minimum is mandatory.
5. If the board is empty and no direct task was given — say so explicitly instead of inventing work.
6. Do not create cards for things already in the scope docs (`context/12`, `context/25`); do not
   silently expand scope — new ideas go to a new card for the human to prioritize.
7. Split a card only if it genuinely can't land as one coherent change; otherwise keep the story
   in one card + several commits.

## 8. Documentation (mandatory, /docs)

1. **Every exported function, class, hook, and module** carries a doc comment (JSDoc in TS,
   docstrings in Python): what it does, parameters, return value, and any non-obvious constraint
   (units, time zones, side effects). Comments explain constraints, not mechanics.
2. `/docs` is the living documentation of subsystems — one file per subsystem, kept in the same
   commit as the code it describes:
   - `docs/mcp-kanban.md` — task board integration (exists)
   - `docs/architecture.md` — components, data flow, ports (create when the skeleton lands)
   - `docs/api.md` — API endpoints: method, path, request/response DTO, errors
   - `docs/solver.md` — routing model: constraints, weights, reasons extraction, golden plan
   - `docs/data.md` — data model, datasets, importers, generators
   - `docs/runbook.md` — how to run, seed, reset demo, deploy, troubleshoot
3. Documentation is part of the Definition of Done: code change without its docs update is an
   incomplete change. Update `context/` files in the same commit when behavior deviates from them.
4. Every schema/contract change is documented in `docs/api.md` / `docs/data.md` **and** reflected in
   `packages/shared` types.

## 9. Code Style and Reuse

1. TypeScript: `strict`; no `any`, no unsafe casts, no suppressed type errors unless absolutely
   unavoidable (and then with a comment explaining why). All DTOs, props, state, and form values
   strictly typed. Types live in `packages/shared` when shared across apps.
2. Python (solver): follow the existing module layout (model / reasons / metrics / matrix); type
   hints on public functions; `ruff`-clean; times are integer seconds inside OR-Tools, minutes at
   the API boundary, local-to-city everywhere at the edges (`context/09` §6).
3. UI: only components from the design system (`context/10`); Tailwind utility patterns as already
   established; no inline colors or ad-hoc spacing; animations via framer-motion following
   `context/10` §5 (120–180 ms interactions, 250–350 ms reveals); new screens are responsive from
   the start; empty/error/loading states are part of the component, not an afterthought.
4. Explanations of solver decisions are structured JSON factors (`context/11` §3) — never
   hand-written strings.
5. LLM never makes planning decisions and never mutates the plan; it only converts text ↔ structure
   with validation and a manual fallback (`context/29` D-11).
6. Match the surrounding code's naming, comment density, and idiom. No comments that narrate
   mechanics; comments state constraints the code can't show.

## 10. Backend Contracts Missing / Not Ready

1. Do not pretend the backend exists; do not fake data in its place.
2. Prepare the frontend fully for integration without requiring later frontend rework: define
   types, build the API layer, wire integration points, implement all UI states.
3. In the report, list every missing contract explicitly: endpoint, HTTP method, request DTO,
   response DTO, and where the frontend expects it.

## 11. Testing

1. **Smoke gate before any merge to `main`**: `pnpm smoke` (`context/27` §10) — seed → matrix →
   solver golden plan within tolerance → SSE new-request → UI renders. If the tooling doesn't exist
   yet, create it as part of the skeleton instead of skipping the gate.
2. Every new module ships with at least one test. No global coverage percentage to chase — but a
   module without tests is an incomplete module.
3. Bug fixes ship with a regression test (red → green).
4. Solver: golden dataset test is the arbiter — fixed seed, known metrics; any deviation must be
   intentional and documented in the commit body.
5. Never claim something was verified if it was not. In the final report, explicitly separate:
   - verified in practice (command + result);
   - verified only logically (reasoning, not executed);
   - not verified.

## 12. Verification and Honesty of Results

1. Any new logic must be checked at least for syntax, validity, consistency, and alignment with the
   project.
2. Never present a proxy signal (green CI, "should work") as proof of user-facing correctness.
3. In the final report, state: what was done, which files/modules were affected, risks and
   limitations, missing contracts, verified / not verified — in that structure.

## 13. Safety and Restrictions

1. Do not modify system settings, Docker daemon, network config, CI/CD, secrets, global env,
   production configs, or external infrastructure without a direct command.
2. Containers: start/stop only per project instructions (`infra/docker-compose.yml`). Normal
   restart is the default; full rebuild (`down --rmi local --volumes`) only when dependencies
   changed or explicitly requested. Do not edit compose/Dockerfiles unless it is the task.
3. If the environment does not start — do not escalate to destructive system actions; report the
   blocker. Project safety outranks forcing the task through.
4. Secrets live in `.env` (git-ignored) and local agent configs — never in the repo, never in
   board cards, never in logs.
5. Server work (MGG): only via `mgg-server-deploy` skill and only on an explicit user command;
   inspect first, explain the deploy path before executing.

## 14. Agent Work Format (per session/task)

1. **First**, briefly state: the task, affected modules, main assumptions.
2. **Then**, a short plan (2–5 bullets).
3. **Then**, the changes — with green-checkpoint commits (§6) on the branch (§5).
4. **Finally**, a brief summary: what was done; files/modules affected; risks and limitations;
   missing contracts (if any); verified / not verified (§12.3); board card updated (§7.3).

## 15. Session Checklist

**Start:** read this file if you haven't → `context/00-README.md` → your zone files
(`context/28` §3) → `git checkout dev && git pull` → board: pick/update your card → branch off
`dev`.
**End:** smoke green → docs + context updated → commits pushed → feature branch merged into `dev`
and pushed → board card moved with a summary comment.

## 16. Definition of Done

- [ ] Task acceptance criteria met (card)
- [ ] Tests: smoke green + module tests + regression test for the fixed bug
- [ ] Docs: doc comments on new public API + `/docs` section updated + `context/` reconciled
- [ ] Commits: green checkpoints, conventional messages, pushed
- [ ] Board: card moved, summary comment left
- [ ] Demo contour still works offline; determinism preserved (golden plan unchanged or explained)
