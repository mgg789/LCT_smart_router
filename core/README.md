# core — LCT Smart Router computation core (prototype)

Day-0 fitting of the OR-Tools planning core (decision D-18 in
`context/29-decision-log.md`): static `SolverInput` → `PlanSolution` with
windows, skills, equipment, transport, shifts, structured reasons and
metrics. Full documentation: [docs/solver.md](../docs/solver.md).

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows / Git Bash
.venv/Scripts/python -m core.gen --scenario mini --seed 42 --out mini.json
.venv/Scripts/python -m core.solve --input mini.json --output solution.json
.venv/Scripts/python -m core.studio --scenario full --seed 42 --port 8017  # interactive map UI
.venv/Scripts/python -m pytest core/tests -q   # from the repository root
```

Design constraints that are easy to violate: plans must be deterministic
(pin `--solution-limit` for demos/tests, see docs/solver.md), requests are
sorted by id before node construction, and every change that shifts the
golden snapshot `tests/golden/mini_solution.json` must regenerate it in the
same commit and explain the delta in the commit body. The studio
(`python -m core.studio`) is a dev tool: it warm-starts replans from the
current plan on every added/cancelled request and expects internet access
for map tiles.
