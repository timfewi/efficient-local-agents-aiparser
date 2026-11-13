"""A lost receipt must stop development spend without breaking competition answers."""

import json
import sqlite3
from types import SimpleNamespace

import httpx
import pytest

from hacklab import agent, optimize, providers
from hacklab.config import Config
from hacklab.models import Task
from hacklab.tracking import NoReceipts, Tracker


def failing_calls(tracker):
    with tracker._db() as db:
        db.executescript("""
            CREATE TRIGGER fail_call_receipt BEFORE INSERT ON calls
            BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;
        """)


def live_config():
    return Config.model_validate(
        {
            "model": {
                "provider": "openai",
                "model": "synthetic-model",
                "base_url": "http://localhost/v1",
                "input_usd_per_million": 1.0,
                "output_usd_per_million": 2.0,
            },
            "agent": {"workflow": "pipeline", "pipeline_rounds": 2},
            "budget": {"max_usd": 1.0},
            "limits": {"max_total_tokens": 100000},
        }
    )


def mock_transport(monkeypatch, replies):
    monkeypatch.setenv("SMALL_MODEL_API_KEY", "synthetic-receipt-test-key")
    requests = []
    client_type = httpx.Client

    def handler(request):
        requests.append(json.loads(request.content))
        reply = replies[min(len(requests) - 1, len(replies) - 1)]
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": json.dumps(reply)}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10},
            },
        )

    monkeypatch.setattr(
        providers.httpx,
        "Client",
        lambda **kwargs: client_type(transport=httpx.MockTransport(handler), **kwargs),
    )
    return requests


def decisions():
    return [
        {"queries": [{"tool": "read", "arguments": {"document": "note.txt"}}]},
        {
            "action": "final",
            "result": {
                "status": "ok",
                "answer": "42 EUR",
                "evidence": ["e1"],
            },
        },
    ]


@pytest.mark.parametrize("strict", [False, True])
def test_failed_call_receipt_preserves_default_answer_but_stops_next_optimizer_role(
    tmp_path,
    monkeypatch,
    strict,
):
    tracker = Tracker(tmp_path / "state" / "tracking.sqlite")
    failing_calls(tracker)
    requests = mock_transport(monkeypatch, decisions())
    if strict:
        monkeypatch.setenv("HACKLAB_OPTIMIZATION_UNKNOWN_BASELINE", "0")
    else:
        monkeypatch.delenv("HACKLAB_OPTIMIZATION_UNKNOWN_BASELINE", raising=False)
    (tmp_path / "note.txt").write_text("Budget approved: 42 EUR.\n")
    run_id, answer = agent.run_task(
        Task(id="receipt-case", question="Approved budget?", documents=["note.txt"]),
        tmp_path,
        live_config(),
        tracker,
    )
    assert tracker.receipts_complete is False
    assert tracker.calls(run_id) == []  # No synthetic request replaces the lost one.
    if strict:
        assert len(requests) == 1
        assert answer.status == "abstain" and answer.cause == "optimization_receipts_incomplete"
    else:
        assert len(requests) == 2
        assert answer.status == "ok" and answer.answer == "42 EUR"


def test_database_failure_health_is_monotonic_and_no_receipts_is_never_complete(tmp_path):
    tracker = Tracker(tmp_path / "state" / "tracking.sqlite")
    assert tracker.receipts_complete is True
    with pytest.raises(sqlite3.OperationalError), tracker._db() as db:
        db.execute("SELECT * FROM missing_synthetic_table")
    assert tracker.receipts_complete is False
    assert tracker.spend()["calls"] == 0
    assert tracker.receipts_complete is False
    assert NoReceipts().receipts_complete is False


def test_native_kit_model_uses_the_same_strict_receipt_health_guard(tmp_path, monkeypatch):
    tracker = Tracker(tmp_path / "state" / "tracking.sqlite")
    failing_calls(tracker)
    monkeypatch.setenv("HACKLAB_OPTIMIZATION_UNKNOWN_BASELINE", "0")
    (tmp_path / "note.txt").write_text("Budget approved: 42 EUR.\n")
    calls = []

    def model(messages):
        calls.append(messages)
        return {
            "choices": [{"message": {"content": json.dumps(decisions()[0])}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 10},
        }

    run_id, answer = agent.run_task(
        Task(id="native-health", question="Approved budget?", documents=["note.txt"]),
        tmp_path,
        live_config(),
        tracker,
        model=model,
    )
    assert len(calls) == 1 and answer.cause == "optimization_receipts_incomplete"
    assert tracker.receipts_complete is False and tracker.calls(run_id) == []


def test_measurement_refuses_false_zero_cost_report_after_a_swallowed_receipt_failure(
    tmp_path,
    monkeypatch,
):
    tracker = Tracker(tmp_path / "state" / "tracking.sqlite")
    failing_calls(tracker)
    requests = mock_transport(monkeypatch, decisions())
    monkeypatch.setenv("HACKLAB_OPTIMIZATION_UNKNOWN_BASELINE", "0")
    config = live_config()
    (tmp_path / "note.txt").write_text("Budget approved: 42 EUR.\n")
    dataset = tmp_path / "cases.jsonl"
    dataset.write_text(
        json.dumps(
            {
                "task": {
                    "id": "health-case",
                    "question": "Approved budget?",
                    "documents": ["note.txt"],
                },
                "expected": {"exact_answer": "42 EUR"},
            }
        )
        + "\n"
    )
    tuning = tmp_path / "tuning.json"
    tuning.write_text(
        json.dumps(
            {
                "configuration": optimize.safe_config(config),
                "budget_ceiling": 1.0,
                "runtime_config_sha256": optimize._digest(config.model_dump()),
            }
        )
    )
    output = tmp_path / "measurement.json"
    args = SimpleNamespace(_tuning=tuning, _out=output, dataset=dataset, root=tmp_path, repeat=1)
    with pytest.raises(RuntimeError, match="^optimization_receipts_incomplete$"):
        optimize._measure(args, config, tracker)
    assert len(requests) == 1 and not output.exists()
    assert tracker.spend()["calls"] == 0


def test_direct_optimizer_proposal_receipt_failure_stops_campaign_and_preserves_uncertainty(
    tmp_path,
    monkeypatch,
):
    tracker = Tracker(tmp_path / "state" / "tracking.sqlite")
    failing_calls(tracker)
    requests = mock_transport(
        monkeypatch,
        [
            {
                "field": "agent.inventory",
                "value": False,
                "hypothesis": "adjust_inventory",
            }
        ],
    )
    monkeypatch.setenv("HACKLAB_OPTIMIZATION_UNKNOWN_BASELINE", "0")
    measurements = []

    def baseline(config, remaining):
        measurements.append("baseline")
        return {
            "dataset_sha256": "a" * 64,
            "tasks": 1,
            "accuracy": 1.0,
            "cost_usd": 0.0,
            "known_cost_usd": 0.0,
            "unknown_cost_calls": 0,
            "usage_complete": True,
            "calls": 0,
            "mode": "openai",
        }

    result = optimize.run_campaign(
        live_config(),
        tracker,
        baseline,
        optimize.ModelProposer(tracker, "b" * 40),
        git_head="b" * 40,
        dev_digest="a" * 64,
        max_iterations=3,
    )
    assert result["status"] == "unknown_cost" and result["spend_complete"] is False
    assert len(requests) == 1 and measurements == ["baseline"]
    assert tracker.spend()["calls"] == 0
    with tracker._db() as db:
        trials = list(db.execute("SELECT * FROM optimization_trials ORDER BY id"))
        assert len(trials) == 2
        decision = json.loads(trials[-1]["decision_json"])
        assert decision["accepted"] is False
        assert decision["reason"] == "receipts_incomplete"
        assert decision["unobserved_external_attempt_possible"] is True
        assert json.loads(trials[-1]["report_json"])["cost_usd"] is None
