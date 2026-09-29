#!/usr/bin/env python3
"""Regeocode the official TZ dataset geocode packages with real LocationIQ points.

Pipeline (offline-resumable, deliberately dependency-free stdlib):

1. Parse the organizer CSVs (cp1251, ``;``) exactly like
   ``apps/api/src/orchestrator/imports/dataset.parser.ts``: numeric ``Заявка`` ids are
   requests, the trailing ``адрес офиса`` row carries the depot address in the
   ``Тип заявки BK`` column.
2. Forward-geocode every distinct address through LocationIQ (Nominatim-based) with a
   hard 60 requests/minute budget and a ladder of query spellings (raw → expanded
   street types → without housing → without street type → street only).
3. Pick the most specific candidate (house/building over road over district/city),
   validate it against the previous package point, and write a new package in the
   schema validated by ``geocodePackageSchema`` (dataset-import.service.ts):
   ``{schema_version, source, version, entries:[{address, node_id, location,
   match_level, source}]}`` — same addresses, same order, same node_ids.

Inputs:  ./datasets/<region>_{synthetic_data,control_distribution}.csv
         ./original_packages/<region>.json  (previous packages; give order + node_ids)
Outputs: ./out/<region>.json, ./out/report.csv, ./out/report.md
State:   ./cache.json (raw responses per query), ./resolved.json (per-address result)

Usage:
    python3 geocode_locationiq.py --check     # extraction/coverage report, no network
    LOCATIONIQ_TOKEN=... python3 geocode_locationiq.py            # full run (resumable)
    LOCATIONIQ_TOKEN=... python3 geocode_locationiq.py --region southeast

The token is read from the environment only and is never written anywhere.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATASETS = ROOT / "datasets"
ORIGINALS = ROOT / "original_packages"
OUT = ROOT / "out"
CACHE_PATH = ROOT / "cache.json"
RESOLVED_PATH = ROOT / "resolved.json"

REGIONS = ("east", "south_central", "southeast")
OFFICE_MARKER = "адрес офиса"
HEADER_REQUEST = "Заявка"
HEADER_TYPE_BK = "Тип заявки BK"
HEADER_ADDRESS = "Адрес"

ENDPOINT = "https://us1.locationiq.com/v1/search.php"
ALLOWED_URL_PREFIX = "https://us1.locationiq.com/v1/search.php?"
# Every dataset address sits in Moscow or the Moscow Oblast south; bounding the
# search to this box rejects far homonyms (e.g. село Каширское, Voronezh Oblast).
VIEWBOX = "35.8,56.3,39.8,54.2"
# Budget from LOCATIONIQ_RPM (requests per minute; default 60, raised plan allows 110).
MIN_INTERVAL_SEC = 60.0 / float(os.environ.get("LOCATIONIQ_RPM", "60")) + 0.02
HTTP_TIMEOUT_SEC = 20

PACKAGE_VERSION_DATE = "2026-09-29"
PACKAGE_SOURCE = (
    "LocationIQ (Nominatim/OpenStreetMap) forward geocoding of the official address "
    f"catalogue, prepared and cached for offline demo use, {PACKAGE_VERSION_DATE}."
)
ENTRY_SOURCE = "LocationIQ (Nominatim/OpenStreetMap)"

# Candidate ranking: house-level matches win, city-level matches are not accepted
# unless nothing more specific exists for any spelling.
SCORE_EXACT = {"house", "building", "office", "apartments", "construction"}
SCORE_STREET = {"road", "pedestrian", "living_street", "footway", "service", "path"}
SCORE_AREA = {"suburb", "neighbourhood", "quarter", "city_district", "municipality"}
SCORE_REJECT = {"city", "town", "village", "state", "county", "country"}

# Flag anything that moved this far from the previous package point (km) for
# manual review; south-east legitimately contains far-out Podolsk-corridor towns.
DISTANCE_WARN_KM = 25.0

# Addresses the organizer CSV spells in a broken way (missing dots, house number
# glued into the street part). Key = normalized dataset address, value = hand-written
# LocationIQ queries tried first. Kept explicit so the regeocoding stays reproducible.
MANUAL_QUERIES: dict[str, list[str]] = {
    "Москва, ул Юных Ленинцев, д 83с 4": [
        "Москва, Юных Ленинцев улица, 83с4",
        "Москва, Юных Ленинцев улица, 83",
    ],
    # OSM has no building at Самаркандский 137/137а; street point is the honest fallback.
    "Москва, б-р.Самаркандский Квартал 137а, д. к5": [
        "Москва, Самаркандский бульвар, 137",
    ],
    "Москва, ул.11-я Текстильщиков, д. 10": [
        "Москва, 11-я улица Текстильщиков, 10",
        "Москва, улица 11-я Текстильщиков, 10",
    ],
    # OSM maps house 9 but not the 9Б corpus; the house-9 point stands in, flagged.
    "Москва, ул.Красноказарменная, д. 9Б стр. 1": [
        "Москва, Красноказарменная улица, 9",
    ],
    # Кашира/Ступино: the dataset writes the street type after the name; the dataset
    # fractions ``5/1..5/3`` are the corpora ``к1..к3`` mapped 1:1 in OSM.
    "Московская область, г. Кашира Кржижановского ул. д. 5/1": [
        "Московская область, Кашира, улица Кржижановского, 5 к1",
    ],
    "Московская область, г. Кашира Кржижановского ул. д. 5/2": [
        "Московская область, Кашира, улица Кржижановского, 5 к2",
    ],
    "Московская область, г. Кашира Кржижановского ул. д. 5/3": [
        "Московская область, Кашира, улица Кржижановского, 5 к3",
    ],
    "Московская область, г. Кашира Кржижановского ул. д. 7к2": [
        "Московская область, Кашира, улица Кржижановского, 7 к2",
    ],
    "Московская область, г. Кашира Центральная ул. д. 19": [
        "Московская область, Кашира, Центральная улица, 19",
    ],
    "Московская область, г. Кашира Центральная ул. д. 21": [
        "Московская область, Кашира, Центральная улица, 21",
    ],
    "Московская область, г. Ступино Андропова ул. д. 33": [
        "Московская область, Ступино, улица Андропова, 33",
    ],
    "Московская область, г. Ступино Андропова ул. д. 37": [
        "Московская область, Ступино, улица Андропова, 37",
    ],
    "Москва Булатниковский пр-зд. д. 6к1": [
        "Москва, Булатниковский проезд, 6к1",
    ],
    # OSM maps no house on Бирюлёвская улица; street point stands in, flagged.
    "Москва, ул Бирюлёвская, д 1с1": [
        "Москва, Бирюлёвская улица, 1с1",
    ],
    # пгт Востряково-1 is микрорайон Авиационный in OSM; house 14/18 matches exactly.
    "Московская область, г.Домодедово, пгт.Востряково-1, ул.Жуковского, д. 14/18": [
        "Домодедово, Жуковского, 14",
    ],
    # Homonym guards: raw spellings matched Щербинку / Бекасово / Воронежскую область.
    "Москва, ул.Талалихина, д. 16": [
        "Москва, улица Талалихина, 16",
    ],
    "Москва, ул.Городская, д. 9": [
        "Москва, Даниловский район, Городская улица, 9",
    ],
    "Кашира, ул.Юбилейная, д. 8": [
        "Московская область, Кашира, Юбилейная улица, 8",
    ],
    "Кашира, ул.Юбилейная, д. 9": [
        "Московская область, Кашира, Юбилейная улица, 9",
    ],
    # ---- extra days (28–29.09.2026) ------------------------------------------------
    # OSM has no building at Самаркандский 7; street point is the honest fallback.
    "Москва, б-р.Самаркандский, д. к7": [
        "Москва, Самаркандский бульвар, 7",
    ],
    "Москва, ул.11-я Текстильщиков, д. 9": [
        "Москва, 11-я улица Текстильщиков, 9",
    ],
    # OSM maps no 6Б on Болотниковская; street point stands in, flagged.
    "Москва, ул.Болотниковская, д. 6 к Б": [
        "Москва, Болотниковская улица, 6Б",
    ],
    "Домодедово, ул.Каширское шоссе, д. 91 к 1": [
        "Домодедово, Каширское шоссе, 91к1",
    ],
    "Москва Шипиловский пр-зд. д. 63к1": [
        "Москва, Шипиловский проезд, 63к1",
    ],
    # Ленина exists in both Ожерелье and Кашира-3; the dataset row means the city proper.
    "Московская область, г. Кашира Ленина ул. д. 9": [
        "Кашира-3, улица Ленина, 9",
    ],
    # мкр. Западный is implied by Талалихина in Домодедово; the double dot breaks parsing.
    "Московская область, г.Домодедово, мкр..Западный, ул.Талалихина, д. 10": [
        "Домодедово, Талалихина, 10",
    ],
    "Москва Радиальная 6-я ул. д. 5к2": [
        "Москва, 6-я Радиальная улица, 5к2",
    ],
}

_last_request_monotonic = 0.0


def normalize_address(address: str) -> str:
    """Mirrors normalizeAddress() in dataset.parser.ts (both sides of the import join)."""
    value = re.sub(r"^\s*г\.?\s*Город\s+Москва", "Москва", address, flags=re.IGNORECASE)
    value = re.sub(r"^\s*Город\s+Москва", "Москва", value, flags=re.IGNORECASE)
    value = re.sub(r"^\s*г\.\s*Москва", "Москва", value, flags=re.IGNORECASE)
    value = re.sub(r"^\s*обл\.Московская область", "Московская область", value, flags=re.IGNORECASE)
    value = re.sub(r"^\s*МО[,\s]", "Московская область, ", value, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", value).strip()


def read_region_rows(region: str, suffix: str) -> list[dict[str, str]]:
    path = DATASETS / f"{region}_{suffix}.csv"
    with open(path, encoding="cp1251", newline="") as handle:
        return list(csv.DictReader(handle, delimiter=";"))


def extract_addresses(region: str) -> dict[str, str]:
    """Returns normalized address -> original address text for all requests + depot."""
    result: dict[str, str] = {}
    for row in read_region_rows(region, "synthetic_data"):
        request_id = (row.get(HEADER_REQUEST) or "").strip()
        if request_id.lower() == OFFICE_MARKER:
            depot = (row.get(HEADER_TYPE_BK) or "").strip()
            if depot:
                result.setdefault(normalize_address(depot), depot)
            continue
        if not re.fullmatch(r"\d+", request_id):
            continue
        address = (row.get(HEADER_ADDRESS) or "").strip()
        if address:
            result.setdefault(normalize_address(address), address)
    return result


def expand_street_types(address: str) -> str:
    """Writes street-type abbreviations out the way Nominatim expects them."""
    value = address
    for abbrev, full in (
        ("б-р", "бульвар"),
        ("пр-кт", "проспект"),
        ("пр-т", "проспект"),
        ("пр-д", "проезд"),
        ("ул", "улица"),
        ("ш", "шоссе"),
        ("наб", "набережная"),
        ("пер", "переулок"),
        ("пл", "площадь"),
    ):
        value = re.sub(rf"\b{abbrev}\.\s*", f"{full} ", value)
    value = re.sub(r"\bпроезд\.\s*", "проезд ", value)
    return re.sub(r"\s+", " ", value).strip()


def compact_house(address: str) -> str:
    """``д. 128 к 5`` → ``128к5`` (LocationIQ parses glued house numbers better)."""
    value = re.sub(r"\bд\.\s*(\d+[А-Яа-я]?)\s*к\s*(\d+)", r"\1к\2", address)
    value = re.sub(r"\bд\.\s*(\d+[А-Яа-я]?)\s*стр\.\s*(\d+)", r"\1с\2", value)
    value = re.sub(r"\bд\.\s*(\d+[А-Яа-я]?)", r"\1", value)
    return value


def drop_housing(address: str) -> str:
    """Remares корпус/строение away: keeps street + house number only."""
    value = re.sub(r"[,\s]+к\s*\d+\s*$", "", address)
    value = re.sub(r"[,\s]+стр\.\s*\d+\s*$", "", value)
    return value.strip().rstrip(",")


def drop_street_type(address: str) -> str:
    """Removes the street-type word: ``Волгоградский проспект`` → ``Волгоградский``."""
    value = re.sub(
        r"\b(бульвар|проспект|проезд|улица|шоссе|набережная|переулок|площадь)\s+",
        "",
        address,
    )
    value = re.sub(
        r"\b(б-р|пр-кт|пр-т|пр-д|ул|ш|наб|пер|пл|проезд)\.\s*",
        "",
        value,
    )
    return re.sub(r"\s+", " ", value).strip()


def drop_house(address: str) -> str:
    """Street without the house: last-resort spelling flagged as road-level."""
    value = re.sub(r",\s*\d+к?\d*[А-Яа-я]?\s*$", "", address)
    value = re.sub(r",\s*д\.\s*\S+\s*$", "", value)
    return value.strip().rstrip(",")


def query_variants(address: str) -> list[str]:
    """Ordered ladder of query spellings; raw form first, degraded forms last."""
    base = normalize_address(address)
    expanded = expand_street_types(base)
    compacted = compact_house(expanded)
    variants = [base, compacted]
    without_housing = compact_house(drop_housing(expanded))
    variants.append(without_housing)
    variants.append(drop_street_type(without_housing))
    variants.append(drop_house(without_housing))
    seen: set[str] = set()
    ordered: list[str] = []
    for variant in variants:
        variant = variant.strip()
        if variant and variant not in seen:
            seen.add(variant)
            ordered.append(variant)
    return ordered


def load_json(path: Path, default: object) -> object:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path: Path, payload: object) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


_throttle_state = {"last": 0.0}


def rate_limited_get(url: str) -> tuple[int, str]:
    """GET with the 60 req/min budget enforced across the whole process."""
    global _last_request_monotonic  # noqa: PLW0603
    wait = _throttle_state["last"] + MIN_INTERVAL_SEC - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _throttle_state["last"] = time.monotonic()
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "lct-smart-router-dataset-geocode/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SEC) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", errors="replace")


def geocode_query(query: str, token: str, cache: dict[str, object]) -> tuple[int, list[dict]]:
    """Returns (status, candidates) for one query spelling; network results cached."""
    key = hashlib.sha256(query.encode("utf-8")).hexdigest()
    hit = cache.get(key)
    if isinstance(hit, dict) and hit.get("query") == query:
        return int(hit["status"]), list(hit.get("candidates", []))
    params = urllib.parse.urlencode(
        {
            "key": token,
            "q": query,
            # LocationIQ v1/search accepts format=json (jsonv2 answers 400 there).
            "format": "json",
            "limit": 5,
            "addressdetails": 0,
            "countrycodes": "ru",
            "viewbox": VIEWBOX,
            "bounded": 1,
        }
    )
    url = f"{ENDPOINT}?{params}"
    if not url.startswith(ALLOWED_URL_PREFIX):
        raise ValueError("request URL left the LocationIQ endpoint allowlist")
    for attempt in range(3):
        status, body = rate_limited_get(url)
        if status == 429:
            # Budget overrun reported anyway: back off well beyond one minute.
            time.sleep(65)
            continue
        if status >= 500:
            time.sleep(5)
            continue
        break
    candidates: list[dict] = []
    if status == 200:
        try:
            candidates = json.loads(body)
            if not isinstance(candidates, list):
                candidates = []
        except json.JSONDecodeError:
            candidates = []
    cache[key] = {"query": query, "status": status, "candidates": candidates}
    save_json(CACHE_PATH, cache)
    return status, candidates


def candidate_score(candidate: dict) -> int:
    # OSM building matches carry type="yes"; the class field is the informative one.
    kinds = {str(candidate.get("type") or "").lower(), str(candidate.get("class") or "").lower()}
    if kinds & SCORE_EXACT:
        return 3
    if str(candidate.get("class") or "").lower() == "highway" or kinds & SCORE_STREET:
        return 2
    if kinds & SCORE_AREA:
        return 1
    return 0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def run_check() -> int:
    """Extraction and coverage audit without any network usage."""
    ok = True
    for region in REGIONS:
        extracted = extract_addresses(region)
        package = json.loads((ORIGINALS / f"{region}.json").read_text(encoding="utf-8"))
        packaged = {normalize_address(entry["address"]) for entry in package["entries"]}
        missing = sorted(extracted.keys() - packaged)
        extra = sorted(packaged - extracted.keys())
        print(
            f"{region}: extracted={len(extracted)} package={len(package['entries'])} "
            f"missing_in_package={len(missing)} extra_in_package={len(extra)}"
        )
        for address in missing:
            ok = False
            print(f"  MISSING {address}")
        for address in extra:
            print(f"  extra   {address}")
    return 0 if ok else 1


def run_region(region: str, token: str, cache: dict, resolved: dict) -> tuple[list[dict], list[dict]]:
    """Geocodes one region; returns (report_rows, unresolved_addresses)."""
    package = json.loads((ORIGINALS / f"{region}.json").read_text(encoding="utf-8"))
    rows: list[dict] = []
    unresolved: list[dict] = []
    for entry in package["entries"]:
        address = entry["address"]
        norm = normalize_address(address)
        result = resolved.get(norm)
        if result is None:
            # Hand-written spellings repair broken organizer rows; then every spelling
            # of the ladder is tried and the globally best candidate wins — stopping at
            # the first street-level hit would miss house-level matches further down.
            best: dict | None = None
            best_score = -1
            used_variant: str | None = None
            ladder = MANUAL_QUERIES.get(norm, []) + query_variants(address)
            for variant in ladder:
                status, candidates = geocode_query(variant, token, cache)
                if status != 200:
                    continue
                for candidate in candidates:
                    score = candidate_score(candidate)
                    if score < best_score or (
                        score == best_score
                        and best is not None
                        and float(candidate.get("importance") or 0.0)
                        <= float(best.get("importance") or 0.0)
                    ):
                        continue
                    best = candidate
                    best_score = score
                    used_variant = variant
            if best is None or best_score == 0:
                unresolved.append({"region": region, "address": address})
                rows.append(
                    {
                        "region": region,
                        "node_id": entry.get("node_id", ""),
                        "address": address,
                        "status": "UNRESOLVED",
                    }
                )
                continue
            found = best
            result = {
                "lat": float(found["lat"]),
                "lon": float(found["lon"]),
                "class": found.get("class", ""),
                "type": found.get("type", ""),
                "display_name": found.get("display_name", ""),
                "variant": used_variant,
            }
            resolved[norm] = result
            save_json(RESOLVED_PATH, resolved)
        old = entry.get("location", {})
        distance = (
            haversine_km(old["lat"], old["lon"], result["lat"], result["lon"])
            if old
            else float("nan")
        )
        rows.append(
            {
                "region": region,
                "node_id": entry.get("node_id", ""),
                "address": address,
                "status": "OK",
                "lat": result["lat"],
                "lon": result["lon"],
                "class": result["class"],
                "type": result["type"],
                "dist_old_km": round(distance, 2),
                "flag": "DISTANCE" if distance > DISTANCE_WARN_KM else "",
                "variant": result["variant"],
                "display_name": result["display_name"],
            }
        )
    return rows, unresolved


def build_package(region: str, rows: list[dict]) -> dict:
    """Assembles the new package in the previous package's entry order."""
    package = json.loads((ORIGINALS / f"{region}.json").read_text(encoding="utf-8"))
    by_node = {row["node_id"]: row for row in rows if row.get("status") == "OK"}
    entries = []
    for entry in package["entries"]:
        row = by_node[entry["node_id"]]
        match_level = f"{row['class']}:{row['type']}" if row.get("class") else row["type"]
        entries.append(
            {
                "address": entry["address"],
                "node_id": entry["node_id"],
                "location": {"lat": row["lat"], "lon": row["lon"]},
                "match_level": match_level,
                "source": ENTRY_SOURCE,
            }
        )
    return {
        "schema_version": "1.0",
        "version": f"official-{region}-geocodes-locationiq-{PACKAGE_VERSION_DATE}",
        "source": PACKAGE_SOURCE,
        "entries": entries,
    }


def write_report(all_rows: list[dict], all_unresolved: list[dict]) -> None:
    """Human-readable provenance report next to the rebuilt packages."""
    columns = [
        "region", "node_id", "address", "status", "lat", "lon",
        "class", "type", "dist_old_km", "flag", "variant", "display_name",
    ]
    with open(OUT / "report.csv", "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(all_rows)

    flags = [row for row in all_rows if row.get("flag")]
    types: dict[str, int] = {}
    for row in all_rows:
        if row.get("status") == "OK":
            name = f"{row['class']}:{row['type']}" if row.get("class") else row["type"]
            types[name] = types.get(name, 0) + 1
    lines = [
        "# LocationIQ regeocoding report",
        "",
        f"Resolved: {sum(1 for r in all_rows if r.get('status') == 'OK')} / {len(all_rows)}",
        f"Unresolved: {len(all_unresolved)}",
        "",
        "Match types: "
        + ", ".join(f"{name}={count}" for name, count in sorted(types.items()))
        + "",
        "",
        f"Flagged (>{DISTANCE_WARN_KM:.0f} km from the previous point): {len(flags)}",
    ]
    for row in flags:
        lines.append(f"- {row['region']}/{row['node_id']} {row['address']} → {row['dist_old_km']} km")
    if all_unresolved:
        lines.extend(["", "## Unresolved", ""])
        for row in all_unresolved:
            lines.append(f"- {row['region']}: {row['address']}")
    (OUT / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    args = sys.argv[1:]
    check_only = "--check" in args
    regions = REGIONS
    if "--region" in args:
        picked = args[args.index("--region") + 1]
        if picked not in REGIONS:
            print(f"unknown region: {picked}", file=sys.stderr)
            return 2
        regions = (picked,)

    if check_only:
        return run_check()

    token = os.environ.get("LOCATIONIQ_TOKEN", "").strip()
    if not token:
        print("LOCATIONIQ_TOKEN environment variable is required", file=sys.stderr)
        return 2

    OUT.mkdir(exist_ok=True)
    cache: dict = load_json(CACHE_PATH, {})  # type: ignore[assignment]
    resolved: dict = load_json(RESOLVED_PATH, {})  # type: ignore[assignment]
    all_rows: list[dict] = []
    all_unresolved: list[dict] = []
    for region in regions:
        print(f"== {region}")
        rows, unresolved = run_region(region, token, cache, resolved)
        all_rows.extend(rows)
        all_unresolved.extend(unresolved)
        if unresolved:
            print(f"   {region}: {len(unresolved)} unresolved, package not built:")
            for item in unresolved:
                print(f"     - {item['address']}")
            continue
        package = build_package(region, rows)
        (OUT / f"{region}.json").write_text(
            json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"   resolved {len(rows)}/{len(rows)}")
    write_report(all_rows, all_unresolved)
    return 0 if not all_unresolved else 1


if __name__ == "__main__":
    sys.exit(main())
