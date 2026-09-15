"""Standalone offline calculation and single-worker Router service commands."""

import argparse
import json
import os
from pathlib import Path

from core.engine import SearchSettings
from core.geo import Gazetteer, GraphTravel, RoadGraph
from core.osrm import OSRMTravel
from core.runtime import FileSnapshotReader, PostgresSnapshotReader, RouterRuntime, calculate


def main() -> None:
    """Parse CLI arguments; run real calculation or the autonomous private service."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("solve", "serve"):
        command = commands.add_parser(name)
        resource = command.add_mutually_exclusive_group(required=True)
        resource.add_argument("--graph", type=Path)
        resource.add_argument("--osrm-config", type=Path)
        command.add_argument("--snapshot", type=Path)
        command.add_argument("--budget-ms", type=int, default=3000)
        if name == "solve":
            command.add_argument("--output", type=Path)
        else:
            command.add_argument("--port", type=int, default=8100)
    geocode = commands.add_parser("geocode")
    geocoding_source = geocode.add_mutually_exclusive_group(required=True)
    geocoding_source.add_argument("--catalog", type=Path)
    geocoding_source.add_argument("--nominatim-config", type=Path)
    geocode.add_argument("address")
    export = commands.add_parser("export-map")
    export.add_argument("--result", type=Path, required=True)
    export.add_argument("--output", type=Path, required=True)
    project = commands.add_parser("project")
    project.add_argument("--graph", type=Path, required=True)
    project.add_argument("--lat", type=float, required=True)
    project.add_argument("--lon", type=float, required=True)
    project.add_argument("--limit-m", type=float, default=100)
    benchmark = commands.add_parser("benchmark")
    benchmark.add_argument("--region", choices=("east",), default="east")
    benchmark.add_argument("--dataset-dir", type=Path, default=Path("data/dataset/anonymized"))
    benchmark.add_argument("--scenario-dir", type=Path)
    benchmark.add_argument("--budget-ms", type=int, default=3000)
    benchmark.add_argument("--solution-limit", type=int, default=32)
    benchmark.add_argument("--skip-events", action="store_true")
    benchmark.add_argument("--event-budget-ms", type=int, default=1000)
    benchmark.add_argument("--output", type=Path)
    prepare_2gis = commands.add_parser("prepare-2gis")
    prepare_2gis.add_argument("--snapshot", type=Path, required=True)
    prepare_2gis.add_argument("--config", type=Path, required=True)
    prepare_2gis.add_argument("--output", type=Path, required=True)
    prepare_2gis.add_argument("--departure-at", type=int)
    prepare_2gis.add_argument(
        "--profiles",
        nargs="+",
        choices=("car", "walk", "bike", "transit"),
        default=("car", "walk", "bike", "transit"),
    )
    args = parser.parse_args()
    if args.command == "export-map":
        from core.contracts import RouterResult
        from core.export import plan_geojson

        result = RouterResult.model_validate_json(args.result.read_bytes())
        if result.status != "ready" or result.main is None:
            parser.error("map export needs a ready main result")
        args.output.write_text(
            json.dumps(plan_geojson(result.main), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return
    if args.command == "geocode":
        if args.catalog:
            entries = Gazetteer.from_file(args.catalog).lookup(args.address)
        else:
            from core.geocoding import NominatimGeocoder

            config = json.loads(args.nominatim_config.read_text(encoding="utf-8"))
            provider = NominatimGeocoder(
                config["endpoint"],
                Path(config["cache_dir"]),
                config["user_agent"],
                dataset_version=config["dataset_version"],
                offline=config.get("offline", True),
            )
            entries = provider.lookup(args.address)
        print(json.dumps([e.model_dump() for e in entries], ensure_ascii=False, indent=2))
        return
    if args.command == "benchmark":
        from core.benchmark import benchmark_payload, run_official_benchmark
        from core.official import load_official_east

        scenario = load_official_east(args.dataset_dir, args.scenario_dir)
        run = run_official_benchmark(
            scenario,
            SearchSettings(
                time_limit_ms=args.budget_ms,
                solution_limit=args.solution_limit,
            ),
            event_settings=(
                SearchSettings(
                    time_limit_ms=args.event_budget_ms,
                    solution_limit=args.solution_limit,
                )
                if not args.skip_events
                else None
            ),
        )
        payload = json.dumps(benchmark_payload(run), ensure_ascii=False, indent=2)
        if args.output:
            args.output.write_text(payload + "\n", encoding="utf-8")
        else:
            print(payload)
        return
    if args.command == "prepare-2gis":
        from core.runtime import parse_snapshot
        from core.twogis import TwoGISConfig, TwoGISMatrixProvider

        config = TwoGISConfig.model_validate_json(args.config.read_bytes())
        snapshot = parse_snapshot(args.snapshot.read_bytes())
        graph = TwoGISMatrixProvider(config).build_graph(
            snapshot,
            departure_at=args.departure_at,
            profiles=tuple(args.profiles),
        )
        args.output.write_text(graph.model_dump_json(indent=2) + "\n", encoding="utf-8")
        return
    if args.graph:
        graph = RoadGraph.model_validate_json(args.graph.read_bytes())
    else:
        config = json.loads(args.osrm_config.read_text(encoding="utf-8"))
        graph = OSRMTravel(
            config["endpoints"],
            config["map_version"],
            Path(config["cache_dir"]),
            offline=config.get("offline", True),
        )
    if args.command == "project":
        from core.contracts import GeoPoint

        match = GraphTravel(graph).nearest(GeoPoint(lat=args.lat, lon=args.lon), args.limit_m)
        print(
            json.dumps(
                {"node_id": match[0], "location": match[1].model_dump(), "distance_m": match[2]}
                if match
                else None
            )
        )
        return
    settings = SearchSettings(time_limit_ms=args.budget_ms)
    if args.snapshot:
        reader = FileSnapshotReader(args.snapshot)
    else:
        dsn = os.environ.get("ROUTER_DATABASE_URL")
        if not dsn:
            parser.error("pass --snapshot or configure ROUTER_DATABASE_URL")
        reader = PostgresSnapshotReader(dsn)
    if args.command == "solve":
        runtime = RouterRuntime(reader, graph, settings)
        try:
            result, _ = calculate(reader.read(), graph, settings, runtime.context_version)
        finally:
            runtime.close()
        payload = result.model_dump_json(indent=2)
        if args.output:
            args.output.write_text(payload + "\n", encoding="utf-8")
        else:
            print(payload)
        if result.status == "error":
            raise SystemExit(1)
    else:
        import uvicorn

        from core.api import create_app

        uvicorn.run(
            create_app(RouterRuntime(reader, graph, settings)),
            host="127.0.0.1",
            port=args.port,
            workers=1,
        )


if __name__ == "__main__":
    main()
