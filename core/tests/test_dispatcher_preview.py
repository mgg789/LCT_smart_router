"""A what-if calculation never mutates the live Router publication or result."""

import pytest
from core.api import create_app
from core.engine import SearchSettings
from core.geo import content_hash
from core.runtime import RouterRuntime
from fastapi.testclient import TestClient


class Reader:
    """Keep the live publication separate from an unpublished candidate."""

    def __init__(self, raw):
        self.raw = raw

    def read(self):
        return self.raw


def test_preview_is_identity_bound_cached_and_does_not_apply(snapshot, graph):
    raw = snapshot.model_dump_json()
    runtime = RouterRuntime(Reader(raw.encode()), graph, SearchSettings(time_limit_ms=100))
    client = TestClient(create_app(runtime))
    original = runtime.read_result()
    body = {
        "publication": {
            "publication_id": "proposal-1",
            "publication_seq": 0,
            "payload_utf8": raw,
            "payload_sha256": content_hash(raw.encode()),
            "published_at_epoch": snapshot.planning_as_of,
        },
        "expected_context_version": runtime.context_version,
    }
    first = client.post("/v1/dispatcher-preview", json=body)
    assert first.status_code == 200
    assert first.json()["input_publication_id"] == "proposal-1"
    assert first.json()["main"]["summary"]["assigned_count"] == 3
    assert (
        client.post("/v1/dispatcher-preview", json=body).json()["result_id"]
        == first.json()["result_id"]
    )
    assert runtime.read_result() == original
    body["publication"]["payload_sha256"] = "0" * 64
    assert client.post("/v1/dispatcher-preview", json=body).status_code == 422
    body["publication"]["payload_sha256"] = content_hash(raw.encode())
    body["expected_context_version"] = "stale"
    assert client.post("/v1/dispatcher-preview", json=body).status_code == 409
    runtime.close()


def test_concurrent_preview_is_refused_without_changing_live_state(snapshot, graph):
    from core.contracts import SnapshotPublicationEnvelope

    raw = snapshot.model_dump_json()
    runtime = RouterRuntime(Reader(raw.encode()), graph, SearchSettings(time_limit_ms=100))
    publication = SnapshotPublicationEnvelope(
        publication_id="proposal-busy",
        publication_seq=0,
        payload_utf8=raw,
        payload_sha256=content_hash(raw.encode()),
        published_at_epoch=snapshot.planning_as_of,
    )
    runtime._preview_lock.acquire()
    try:
        with pytest.raises(RuntimeError, match="PREVIEW_BUSY"):
            runtime.preview_dispatcher_plan(publication, runtime.context_version)
    finally:
        runtime._preview_lock.release()
        runtime.close()
