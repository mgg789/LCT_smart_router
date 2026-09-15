"""Map integration exports only verified geometry, never invented straight routes."""

from core.contracts import Plan


def plan_geojson(plan: Plan) -> dict:
    """Return GeoJSON lon/lat features with engineer/stop IDs for any map frontend."""
    features = []
    if not plan.is_usable:
        return {"type": "FeatureCollection", "features": []}
    for route in plan.routes:
        for leg in route.legs:
            if leg.geometry and len(leg.geometry.points) >= 2:
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[p.lon, p.lat] for p in leg.geometry.points],
                        },
                        "properties": {
                            "engineer_id": route.engineer_id,
                            "leg_id": leg.leg_id,
                            "travel_time_sec": leg.travel_time_sec,
                            "distance_km": leg.distance_km,
                        },
                    }
                )
        for stop in route.stops:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [stop.location.lon, stop.location.lat],
                    },
                    "properties": {
                        "engineer_id": route.engineer_id,
                        "stop_id": stop.stop_id,
                        "kind": stop.kind,
                        "request_id": stop.request_id,
                        "start_at": stop.start_at,
                        "end_at": stop.end_at,
                    },
                }
            )
    return {"type": "FeatureCollection", "features": features}
