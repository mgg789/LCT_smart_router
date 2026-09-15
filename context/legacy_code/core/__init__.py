"""LCT Smart Router — computational core prototype.

Static route planning for field engineers on Google OR-Tools (Routing / GLS).
This package is a day-0 fitting of the solver core; it is planned to move to
``apps/solver`` when the monorepo skeleton lands (decision D-18 in
``context/29-decision-log.md``).

Module layout follows AGENTS.md §9.2: types (contracts) / matrix / model /
reasons / metrics, plus a seeded dataset generator (``gen``) and a CLI
entrypoint (``solve``).

Time conventions (context/09 §6):
- JSON boundary: minutes since local-city midnight, rendered as "HH:MM";
- inside OR-Tools: integer seconds;
- the solver never sees a timezone — everything is local to the city.
"""

__version__ = "0.1.0"
