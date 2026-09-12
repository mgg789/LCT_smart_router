"""Studio tests: the local replanning playground through its HTTP surface."""

from __future__ import annotations

from fastapi.testclient import TestClient

from core.studio import Studio, create_app

MOSCOW_POINT = {"lat": 55.7600, "lon": 37.6250}


def make_client() -> TestClient:
    studio = Studio("mini", 42, "2026-09-14", time_limit_ms=800)
    return TestClient(create_app(studio))


def test_state_and_index_page():
    client = make_client()
    page = client.get("/")
    assert page.status_code == 200
    assert "LCT Studio" in page.text

    state = client.get("/api/state").json()
    assert state["version"] == 1
    assert state["scenario"] == "mini"
    assert len(state["requests"]) == 10
    assert all(req["status"] == "assigned" for req in state["requests"])
    assert len(state["engineers"]) == 5
    assert len(state["work_types"]) == 8
    assert set(state["metrics"]["moves_vs_prev"]) == {"reassigned", "shifted"}


def test_add_request_replans_and_shows_diff():
    client = make_client()
    payload = dict(MOSCOW_POINT, work_type="replace_router", window_start="12:00",
                   window_end="15:00", window_strict=False, priority="std")
    resp = client.post("/api/requests", json=payload)
    assert resp.status_code == 200
    state = resp.json()
    assert state["version"] == 2
    assert state["metrics"]["assigned"] == 11
    new_req = [r for r in state["requests"] if r["id"].startswith("req_new_")]
    assert len(new_req) == 1 and new_req[0]["status"] == "assigned"
    assert new_req[0]["id"] in state["last_event"]["added"]
    assert state["reasons"][new_req[0]["id"]]["assignment"]["factors"]


def test_cancel_request():
    client = make_client()
    resp = client.post("/api/requests/req_003/cancel")
    assert resp.status_code == 200
    state = resp.json()
    assert state["version"] == 2
    assert state["metrics"]["requests_total"] == 9
    assert state["last_event"]["cancelled"] == ["req_003"]
    assert all(r["id"] != "req_003" for r in state["requests"])
    assert all("req_003" not in ids for ids in state["routes"].values())


def test_unknown_work_type_and_unknown_cancel_are_400():
    client = make_client()
    bad = dict(MOSCOW_POINT, work_type="teleport", window_start="10:00", window_end="12:00")
    assert client.post("/api/requests", json=bad).status_code == 400
    assert client.post("/api/requests/req_999/cancel").status_code == 400


def test_weights_and_reset():
    client = make_client()
    state = client.post("/api/weights", json={"sla": 1000000, "balance": 500, "travel": 1}).json()
    assert state["version"] == 2
    reset = client.post("/api/reset").json()
    assert reset["version"] == 3
    assert reset["metrics"]["assigned"] == 10
    assert reset["metrics"]["moves_vs_prev"]["reassigned"] == 0
