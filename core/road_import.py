"""Compatibility import for the OSRM road resource boundary."""

from core.roadimport import (  # noqa: F401
    MAX_EDGES,
    MAX_GEOMETRY_POINTS,
    MAX_IMPORT_BYTES,
    MAX_NODES,
    PROFILES,
    RoadGraphStore,
    RoadImportError,
    RoadImportResult,
    decode_payload,
    import_into_runtime,
    merge_graph,
    parse_import,
)

__all__ = [
    "MAX_EDGES",
    "MAX_GEOMETRY_POINTS",
    "MAX_IMPORT_BYTES",
    "MAX_NODES",
    "PROFILES",
    "RoadGraphStore",
    "RoadImportError",
    "RoadImportResult",
    "decode_payload",
    "import_into_runtime",
    "merge_graph",
    "parse_import",
]
