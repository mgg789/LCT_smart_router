# AGENTS.md — LCT Smart Router

Rules for any AI agent (Claude Code, Codex, Cursor, ZCode) and human contributor working in this repository.
Team language is Russian; **code, comments, identifiers, commits, PRs, and docs are written in English.**

## Team memory (RAGConnect) — read first

Shared cloud memory of the team: `project_label="lct"`; connect guide and details: `docs/ragconnect.md`.
The kanban MCP moves cards, the memory stores knowledge — use both.

- **Search before large work or context gathering**:
  `memory_search {"query": "...", "project_label": "lct"}` — decisions (D-1…), root causes, dataset
  facts, contracts, completed work. Complements `context/` files, never replaces them.
- **Write back on every addition or change** (decision, root cause, milestone, changed fact/plan/status):
  `memory_write {"text": "<fact + context + date>", "project_label": "lct"}`. When a fact changes, add a
  new entry marked `supersedes: <old fact>` — stale memory is worse than none.
- **No `memory_*` tools connected?** Recommend the user connect the MCP (`docs/ragconnect.md`, ~2 min)
  for full project work, then continue without blocking. Secrets never go into memory (§13.4);
  label-less (local) memory is for personal notes only.

## 0. Project Overview

**LCT Smart Router** — web service for intelligent planning and live re-planning of field engineer
routes (Beeline Business case, LCT 2026). Distributes work orders by qualification and availability,
respects time windows, checks transport/equipment compatibility, minimizes travel and SLA violations,
re-plans on new requests, and **explains the plan on a map**. Strategy: **not** "many features" — one
thought-through, beautiful tool; explainability is the core trust feature.

| Link | What |
|---|---|
| https://git.sourcecraft.dev/lct-hackaton-2026/case-13-field-engineer-routing-team-22 | **This repository** (primary, migrated 2026-09-15) |
| https://github.com/mgg789/LCT_smart_router | Original repo (frozen, read-only history) |
| https://task.droidje.com | **Main task board** (kan.bn, workspace `LCT`) — via `kan` MCP |
| `context/INDEX.md` | **Context map: contents, per-task routing, creation rules — entry point for all context** |
| `context/26-case-source.md` / `context/29-decision-log.md` | Verbatim case statement / accepted decisions D-1…D-17 |
| `docs/` | Project documentation (see §8), incl. `docs/mcp-kanban.md` and `docs/ragconnect.md` |

Stack (rationale: `context/16`): pnpm monorepo — `apps/web` (React + TS + Vite + Tailwind + MapLibre +
framer-motion), `apps/api` (Fastify or FastAPI), `apps/solver` (Python + OR-Tools), `packages/shared`
(contract types), PostgreSQL, docker-compose (`infra/`).

## 1. Sources of Truth (priority ladder)

1. Safety of the system, data, repository, and the demo environment
2. The user's direct request
3. This file
4. `context/29-decision-log.md` and the `context/` pack (do not re-open decided questions)
5. The kanban board (`kan` MCP) — the task source when the user gave no direct task
6. Other project files

If local standards exist for components, layout, API layer, typing, styles, animations, structure —
follow them strictly; never introduce a second way of doing the same thing.

## 2. Rule Priority (when in doubt)

1. Safety of system, data, and project boundaries
2. Correct execution of the actual task
3. A complete, working result consistent with the project
4. Adherence to architecture, contracts, and local standards
5. Minimal invasiveness of changes
6. Readability and maintainability

## 3. Scope of Work

1. Work only in the area your task belongs to (`apps/web`, `apps/api`, `apps/solver`,
   `packages/shared`, `infra/`, `data/`, `docs/`, `context/`); other areas are read-only
   (read them to understand contracts and integrations).
2. Modifying other areas is forbidden without a direct command.
3. `packages/shared` (contracts) is changed **only by the integration owner** — request contract
   changes via the board card / owner, never edit silently.
4. Server-side infrastructure (MGG server, nginx, DNS, secrets) is off-limits without an explicit
   user command; server ops go through the `mgg-server-deploy` skill only.

## 4. General Execution Rules

1. Write only working, complete code — no placeholders, stubs, or fake logic unless explicitly requested.
2. Before changing anything: understand the task, affected modules, existing patterns, impact on
   adjacent scenarios.
3. **Reuse first** — search for existing components, styles, hooks, services, API layers, design
   tokens; create new only when reuse is impossible. Follow existing architecture and style exactly.
4. Minimal sufficient diff; do not touch unrelated code; no drive-by refactoring.
5. Between a quick hack and a robust in-scope solution — choose the robust one. If a plan implies a
   weak/unsafe/poor solution — do not silently comply: briefly object and propose better.
6. Stuck > ~30 minutes — stop rabbit-holing: post a blocker on the board card and ask the human.
7. All external calls (OSRM, 2GIS, data.mos.ru, Overpass, Open-Meteo, LLM) must be cached and degrade
   gracefully — the demo contour must work **fully offline** (`context/15` §4).
8. Determinism is sacred: solver seeds are fixed; a change that alters the golden plan without
   explanation does not merge (`context/27` §10).

## 5. Branch Management

1. **`dev` is the default working branch**: start sessions with `git checkout dev && git pull`,
   branch feature work off it, merge back into it.
2. **`main` is protected** — the demo-ready mirror ("stage = main" as its *state*): updated only by an
   explicit team-lead merge from `dev` with a green smoke gate. Never push to `main` directly, never
   force-push or rewrite its history. Not the team lead? Your target is `dev`.
3. Naming: `feat/<area>-<slug>`, `fix/<area>-<slug>`, `chore/<slug>`, `docs/<slug>`,
   `refactor/<area>-<slug>`. Branch off `dev`.
4. Short-lived branches (≤ 1–2 days); rebase onto `dev` before merging; merge only with a green smoke
   gate; clear merge commit or fast-forward — no squash that hides checkpoints (history is a demo artifact).
5. One branch = one logical task (one board card); no mixing unrelated work.
6. If your branch needs a `packages/shared` change — coordinate first: the contracts owner applies it,
   you rebase.

## 6. Commits

Conventional Commits, imperative, English — `<type>(<scope>): <summary>` (+ optional body: why,
what, side effects). Types: `feat fix docs style refactor perf test build ci chore`. Scopes: `web`,
`api`, `solver`, `shared`, `infra`, `data`, `docs`, `context`.
Examples: `feat(solver): add lunch-break intervals to routing model`,
`fix(web): keep timeline scroll pinned to plan updates`.

1. Commit at meaningful checkpoints — a working increment a teammate could build on (constraint + test,
   endpoint + test, component + usage, migration + seed) — **and green**: never leave uncommitted work
   others can't build on, never commit red code to a shared branch. Push after every commit session.
2. Messages explain **why**, not just what; a commit that changes the golden plan or metrics must say so.
3. Never commit: secrets, tokens, `.env`, build artifacts, node_modules, OneDrive temp files. A leaked
   secret is rotated immediately and reported.

## 7. Working with Tasks (kan.bn via `kan` MCP)

1. No direct task → go to the board: workspace **LCT** (publicId `1kh73hl7xn3i`, slug `droidje`);
   connection details in `docs/mcp-kanban.md`.
2. Take tasks in card priority order; **≤ 10 cards in progress per pass**.
3. Board reflects reality: before starting — card to *In Progress* + comment "started: <branch>";
   when done — to done + 2–5 line summary (what, where, how verified).
4. Card hygiene: understandable without chat context — goal, acceptance criteria, links. Mandatory
   minimum when creating a card.
5. Board empty and no task given — say so explicitly; do not invent work.
6. No cards for things already in scope docs (`context/12`, `context/18` §3); no silent scope growth —
   new ideas become a new card for the human to prioritize.
7. Split a card only if it genuinely can't land as one coherent change.

## 8. Documentation (mandatory, /docs)

1. Every exported function, class, hook, module carries a doc comment (JSDoc/docstring): purpose,
   params, return, non-obvious constraints (units, time zones, side effects). Comments explain
   constraints, not mechanics.
2. `/docs` — living per-subsystem documentation, same commit as the code: `mcp-kanban.md` (exists),
   `architecture.md`, `api.md`, `solver.md` (exists), `data.md`, `runbook.md`, `ragconnect.md` (exists).
3. Docs are part of Definition of Done: code without its docs update is incomplete. Update the relevant
   `context/` files in the same commit when behavior deviates from them.
4. Every schema/contract change is documented in `docs/api.md` / `docs/data.md` **and** reflected in
   `packages/shared` types.
5. **Context pack (`context/`)**: this file → `context/INDEX.md` → the document. New context file: check
   INDEX first — update the existing file instead of duplicating; must not contradict the canon
   (`context/32`, `context/29`, `context/18`) — divergences are fixed or status-marked; name
   `NN-short_topic.md`, add to INDEX.md in the same commit (missing from INDEX = does not exist);
   superseded files move to `context/archive/` with a "what to read instead" banner.

## 9. Code Style and Reuse

1. TypeScript `strict`: no `any`, no unsafe casts, no suppressed errors unless truly unavoidable (with
   a comment why). Strictly typed DTOs, props, state, form values. Shared types live in `packages/shared`.
2. Python (solver): existing module layout (model / reasons / metrics / matrix); type hints on public
   functions; `ruff`-clean; absolute times are Unix-epoch integer seconds, local date/time only at
   input/output edges (`context/33` §4).
3. UI: design-system components only (`context/10`); established Tailwind patterns; no inline colors or
   ad-hoc spacing; framer-motion per `context/10` §5 (120–180 ms interactions, 250–350 ms reveals);
   responsive from the start; empty/error/loading states are part of the component.
4. Solver explanations are structured JSON factors (`context/11` §3) — never hand-written strings.
5. LLM never makes planning decisions and never mutates the plan; only text ↔ structure with validation
   and a manual fallback (`context/29` D-11).
6. Match surrounding naming, comment density, idiom; comments state constraints the code can't show.

## 10. Backend Contracts Missing / Not Ready

1. Do not pretend the backend exists; do not fake data.
2. Prepare the frontend fully for integration (types, API layer, integration points, all UI states) so
   no later rework is needed.
3. List every missing contract in the report: endpoint, method, request/response DTO, where the
   frontend expects it.

## 11. Testing

1. **Smoke gate**: `pnpm smoke` (`context/27` §10) — seed → matrix → solver golden plan within
   tolerance → SSE new-request → UI renders. Must be green before any merge; if tooling is missing,
   create it — never skip the gate.
2. Every new module ships with at least one test; bug fixes ship with a regression test (red → green).
   A module without tests is an incomplete module.
3. Solver: the golden dataset test is the arbiter — fixed seed, known metrics; deviations must be
   intentional and documented in the commit body.

## 12. Verification and Honesty of Results

1. Never claim verification that did not happen: reports distinguish **verified in practice** (command +
   result), **verified logically** (reasoning), **not verified**. A proxy signal (green CI, "should
   work") is not proof of user-facing correctness.
2. Final report structure: what was done; affected files/modules; risks and limitations; missing
   contracts; verified / not verified.

## 13. Safety and Restrictions

1. No changes to system settings, Docker daemon, network config, CI/CD, secrets, global env, production
   configs, or external infrastructure without a direct command.
2. Containers: normal restart is the default; full rebuild (`down --rmi local --volumes`) only when
   dependencies changed or explicitly requested. Do not edit compose/Dockerfiles unless it is the task.
3. If the environment does not start — report the blocker; do not escalate to destructive system actions.
4. Secrets live in `.env` (git-ignored) and local agent configs — never in the repo, board cards, or logs.
5. Server work (MGG): only via `mgg-server-deploy` skill on an explicit user command; inspect first,
   explain the deploy path before executing.

## 14. Agent Work Format (per session/task)

1. **First**: task, affected modules, main assumptions.
2. **Then**: short plan (2–5 bullets).
3. **Then**: changes with green-checkpoint commits (§6) on the branch (§5).
4. **Finally**: summary per §12.2; board card updated (§7.3).

## 15. Session Checklist

**Start:** this file → `context/INDEX.md` (route to your zone) → `git checkout dev && git pull` →
board: pick/update your card → branch off `dev`.
**End:** smoke green → docs + context updated → commits pushed → branch merged into `dev`, pushed →
board card moved with a summary comment → memory write-back (see "Team memory" above).

## 16. Definition of Done

- [ ] Task acceptance criteria met (card)
- [ ] Tests: smoke green + module tests + regression test for the fixed bug
- [ ] Docs: doc comments on new public API + `/docs` updated + `context/` reconciled
- [ ] Commits: green checkpoints, conventional messages, pushed
- [ ] Board: card moved, summary comment left
- [ ] Demo contour works offline; determinism preserved (golden plan unchanged or explained)
