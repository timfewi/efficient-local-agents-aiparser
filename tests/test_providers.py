import json
import stat

import httpx
import pytest

from hacklab.cache import ResponseCache
from hacklab.config import Config, DevBudget, JevConfig, Limits, ModelConfig
from hacklab.providers import (
    Budget,
    BudgetExceeded,
    DevSpend,
    FunctionModel,
    JevProvider,
    ModelOutputError,
    ProviderError,
    SmallModelProvider,
    chat_endpoint,
    jev_usable,
    make_providers,
)
from hacklab.tracking import Tracker


@pytest.fixture
def receipt(tmp_path, monkeypatch):
    monkeypatch.setenv("SMALL_MODEL_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("TYPESAFE_API_KEY", "synthetic-test-key")
    tracker = Tracker(tmp_path / "state" / "runs.sqlite3")
    run_id = tracker.start_run("test-task", {}, mode="openai")
    return tracker, run_id


def completion(value=None, usage=True, finish="stop"):
    payload = {
        "choices": [
            {
                "message": {"content": json.dumps(value or {"action": "final"})},
                "finish_reason": finish,
            }
        ]
    }
    if usage:
        payload["usage"] = {"prompt_tokens": 20, "completion_tokens": 10}
    return payload


def small(receipt, handler, limits=None, **config):
    tracker, run_id = receipt
    limits = limits or Limits()
    budget = Budget(limits)
    provider = SmallModelProvider(
        ModelConfig(
            provider="openai",
            base_url="http://127.0.0.1:1234/v1",
            model="event-small-model",
            **config,
        ),
        limits,
        budget,
        tracker,
        run_id,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    return provider, budget


def test_http_retry_has_separate_receipts_and_unknown_failed_cost(receipt):
    seen = []

    def handler(request):
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(503, json={"error": "synthetic private provider body"})
        return httpx.Response(200, json=completion())

    provider, budget = small(receipt, handler, input_usd_per_million=1, output_usd_per_million=2)
    assert provider.complete([{"role": "user", "content": "JSON"}], {}) == {"action": "final"}
    assert budget.calls == 2
    calls = receipt[0].calls(receipt[1])
    assert len(calls) == 2
    assert calls[0]["status"] == "http_503"
    assert calls[0]["input_tokens"] is None
    assert receipt[0].summary(receipt[1])["cost_usd"] is None
    assert receipt[0].summary(receipt[1])["known_cost_usd"] == pytest.approx(0.00004)
    body = json.loads(seen[-1].content)
    assert seen[-1].url.path == "/v1/chat/completions"
    assert body["max_tokens"] == 3000
    assert body["response_format"] == {"type": "json_object"}


def test_auth_failure_is_not_retried_and_error_has_no_body(receipt):
    provider, budget = small(
        receipt,
        lambda request: httpx.Response(401, json={"error": "do-not-log-this"}),
    )
    with pytest.raises(ProviderError, match="^provider_http_401$"):
        provider.complete([], {})
    assert budget.calls == 1
    assert receipt[0].calls(receipt[1])[0]["status"] == "http_401"


def test_request_budget_counts_failed_retry_attempts(receipt):
    provider, budget = small(
        receipt,
        lambda request: httpx.Response(429, json={"error": "rate limited"}),
        Limits(max_calls=1, max_retries=3),
    )
    with pytest.raises(BudgetExceeded, match="request_budget_exhausted"):
        provider.complete([], {})
    assert budget.calls == 1
    assert len(receipt[0].calls(receipt[1])) == 1


def test_missing_usage_remains_unknown_even_for_successful_response(receipt):
    provider, budget = small(
        receipt, lambda request: httpx.Response(200, json=completion(usage=False))
    )
    assert provider.complete([], {}) == {"action": "final"}
    assert budget.tokens > 0
    call = receipt[0].calls(receipt[1])[0]
    assert call["input_tokens"] is None
    assert call["output_tokens"] is None
    assert receipt[0].summary(receipt[1])["total_tokens"] is None


def test_call_tracks_reported_model_when_requested_alias_resolves(receipt):
    payload = completion()
    payload["model"] = "event-small-model-2026-11-14"
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json=payload)

    provider, _ = small(receipt, handler)
    provider.complete([], {})
    assert seen[0]["model"] == "event-small-model"
    assert receipt[0].calls(receipt[1])[0]["model"] == "event-small-model-2026-11-14"


@pytest.mark.parametrize("reported", [None, 7, "", "   "])
def test_call_falls_back_to_requested_model_when_response_omits_valid_id(receipt, reported):
    payload = completion()
    payload["model"] = reported
    provider, _ = small(receipt, lambda request: httpx.Response(200, json=payload))
    provider.complete([], {})
    assert receipt[0].calls(receipt[1])[0]["model"] == "event-small-model"


def test_bad_usage_is_not_treated_as_zero(receipt):
    payload = completion()
    payload["usage"] = {"prompt_tokens": True, "completion_tokens": -2}
    provider, _ = small(receipt, lambda request: httpx.Response(200, json=payload))
    provider.complete([], {})
    call = receipt[0].calls(receipt[1])[0]
    assert call["input_tokens"] is None
    assert call["output_tokens"] is None


def test_malformed_model_output_records_returned_usage_without_http_retry(receipt):
    payload = completion()
    payload["choices"][0]["message"]["content"] = "this is not JSON"
    provider, budget = small(receipt, lambda request: httpx.Response(200, json=payload))
    with pytest.raises(ModelOutputError):
        provider.complete([], {})
    assert budget.calls == 1
    call = receipt[0].calls(receipt[1])[0]
    assert call["status"] == "invalid_response"
    assert call["input_tokens"] == 20


def test_truncated_model_output_is_rejected_and_usage_kept(receipt):
    provider, _ = small(
        receipt, lambda request: httpx.Response(200, json=completion(finish="length"))
    )
    with pytest.raises(ModelOutputError, match="model_output_truncated"):
        provider.complete([], {})
    assert receipt[0].calls(receipt[1])[0]["output_tokens"] == 10


def test_transport_retries_are_counted_with_unknown_usage(receipt):
    def handler(request):
        raise httpx.ReadTimeout("synthetic timeout with private endpoint", request=request)

    # A slow endpoint gets one more try, however many retries a lost connection may have.
    provider, budget = small(receipt, handler, Limits(http_retries=4))
    with pytest.raises(ProviderError, match="^provider_timeout$"):
        provider.complete([], {})
    assert budget.calls == 2
    calls = receipt[0].calls(receipt[1])
    assert all(call["input_tokens"] is None and call["status"] == "timeout" for call in calls)


def test_response_decoding_error_is_sanitized_without_retry(receipt):
    def handler(request):
        raise httpx.DecodingError("private decoding details", request=request)

    provider, budget = small(receipt, handler)
    with pytest.raises(ProviderError, match="^provider_content_decoding_error$"):
        provider.complete([], {})
    assert budget.calls == 1
    assert receipt[0].calls(receipt[1])[0]["status"] == "invalid_response"


def test_invalid_endpoint_is_sanitized_with_attempt_receipt(receipt):
    provider, budget = small(receipt, lambda request: pytest.fail("must not send"))
    provider.endpoint = "http://localhost:invalid"
    with pytest.raises(ProviderError, match="^provider_endpoint_invalid$"):
        provider.complete([], {})
    assert budget.calls == 1
    assert receipt[0].calls(receipt[1])[0]["status"] == "invalid_request"


def test_cost_budget_stops_before_any_network_request(receipt):
    requested = []
    provider, budget = small(
        receipt,
        lambda request: requested.append(request),
        Limits(max_cost_usd=0.00000001),
        input_usd_per_million=1,
        output_usd_per_million=2,
    )
    with pytest.raises(BudgetExceeded, match="cost_budget_exhausted_before_request"):
        provider.complete([], {})
    assert requested == []
    assert budget.calls == 0
    assert receipt[0].calls(receipt[1]) == []


def test_token_budget_reserves_output_before_network_request(receipt):
    provider, budget = small(
        receipt,
        lambda request: pytest.fail("must not send"),
        Limits(max_total_tokens=128, max_output_tokens=128),
    )
    with pytest.raises(BudgetExceeded, match="token_budget_exhausted_before_request"):
        provider.complete([], {})
    assert budget.calls == 0


def test_reported_tokens_over_budget_stop_subsequent_work(receipt):
    payload = completion()
    payload["usage"]["completion_tokens"] = 30000
    provider, _ = small(
        receipt,
        lambda request: httpx.Response(200, json=payload),
        Limits(max_total_tokens=16000),
    )
    with pytest.raises(BudgetExceeded, match="reported_token_usage_exceeded_budget"):
        provider.complete([], {})
    assert receipt[0].summary(receipt[1])["total_tokens"] == 30020


def test_clock_budget_blocks_request_without_network():
    now = [0.0]
    budget = Budget(Limits(task_timeout_seconds=2), clock=lambda: now[0])
    now[0] = 3.0
    with pytest.raises(BudgetExceeded, match="task_time_budget_exhausted"):
        budget.reserve({}, 1, None, None)
    assert budget.calls == 0


def test_native_jev_contract_batches_noul_questions(receipt):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "model": "jev-1.14.0",
                "answers": {
                    "grounded": {"type": "noul", "noul": 0.9},
                    "constraints": {"type": "noul", "noul": 0.85},
                },
                "usage": {"input_tokens": 52, "output_tokens": 6},
            },
        )

    limits = Limits()
    budget = Budget(limits)
    provider = JevProvider(
        JevConfig(),
        limits,
        budget,
        *receipt,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    questions = {
        "grounded": {"type": "noul", "instructions": "Claim follows from quotes."},
        "constraints": {"type": "noul", "instructions": "Explicit constraints hold."},
    }
    assert provider.judge({"answer": "synthetic"}, questions) == {
        "grounded": 0.9,
        "constraints": 0.85,
    }
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1/systemone"
    assert set(body) == {"model", "state", "questions"}
    assert body["model"] == "jev-1.14.0"
    assert body["questions"] == questions
    assert receipt[0].summary(receipt[1])["total_tokens"] == 58


@pytest.mark.parametrize(
    "base_url",
    ["http://gateway:8080", "http://gateway:8080/v1/", "http://gateway:8080/v1/systemone"],
)
def test_a_jev_gateway_is_accepted_as_host_prefix_or_full_path(receipt, base_url):
    limits = Limits()
    jev = JevProvider(JevConfig(base_url=base_url), limits, Budget(limits), *receipt)
    try:
        assert jev.endpoint == "http://gateway:8080/v1/systemone"
    finally:
        jev.close()


def test_repeated_jev_failures_open_an_outage_and_a_success_closes_it(receipt):
    reachable = False

    def handler(request):
        if not reachable:
            raise httpx.ConnectError("no route", request=request)
        answers = {"q": {"type": "noul", "noul": 0.9}}
        return httpx.Response(200, json={"model": "jev-1.14.0", "answers": answers})

    limits = Limits(max_retries=0, max_calls=20)
    jev = JevProvider(
        JevConfig(enabled=True),
        limits,
        Budget(limits),
        *receipt,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    question = {"q": {"type": "noul", "instructions": "`x` is true."}}
    assert jev_usable(JevConfig(enabled=True)) and not jev_usable(JevConfig())
    for _ in range(2):
        with pytest.raises(ProviderError, match="provider_transport_error"):
            jev.judge({"x": 1}, question)
    assert jev_usable(JevConfig(enabled=True))
    reachable = True
    assert jev.judge({"x": 1}, question) == {"q": 0.9}
    reachable = False
    for _ in range(3):
        with pytest.raises(ProviderError):
            jev.judge({"x": 1}, question)
    assert not jev_usable(JevConfig(enabled=True))
    # Every failed attempt still has its receipt.
    statuses = [call["status"] for call in receipt[0].calls(receipt[1])]
    assert statuses.count("transport_error") == 5 and statuses.count("ok") == 1


def test_a_replay_miss_is_not_counted_as_a_jev_outage(receipt, tmp_path):
    limits = Limits()
    jev = JevProvider(
        JevConfig(enabled=True),
        limits,
        Budget(limits),
        *receipt,
        cache=ResponseCache(tmp_path / "cache.sqlite", "replay"),
    )
    try:
        for _ in range(4):
            with pytest.raises(ProviderError, match="cache_miss_in_replay_mode"):
                jev.judge({"x": 1}, {"q": {"type": "noul", "instructions": "`x` is true."}})
    finally:
        jev.close()
    assert jev_usable(JevConfig(enabled=True))


@pytest.mark.parametrize("payload", [[], ["not-an-envelope"], 5, "text"])
def test_non_object_api_envelope_has_bounded_error(receipt, payload):
    provider, budget = small(receipt, lambda request: httpx.Response(200, json=payload))
    with pytest.raises(ProviderError, match="provider_response_must_be_object"):
        provider.complete([], {})
    assert budget.calls == 1
    assert receipt[0].calls(receipt[1])[0]["status"] == "invalid_response"


def test_non_object_choice_is_repairable_model_error(receipt):
    provider, _ = small(receipt, lambda request: httpx.Response(200, json={"choices": [None]}))
    with pytest.raises(ModelOutputError, match="model_choice_must_be_object"):
        provider.complete([], {})


def test_jev_non_object_envelope_has_bounded_error(receipt):
    limits = Limits()
    provider = JevProvider(
        JevConfig(),
        limits,
        Budget(limits),
        *receipt,
        client=httpx.Client(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[]))
        ),
    )
    with pytest.raises(ProviderError, match="provider_response_must_be_object"):
        provider.judge({}, {"claim": {"type": "noul", "instructions": "Check."}})
    assert receipt[0].calls(receipt[1])[0]["status"] == "invalid_response"


def test_retry_after_beyond_task_deadline_does_not_retry_early(receipt, monkeypatch):
    provider, budget = small(
        receipt,
        lambda request: httpx.Response(429, json={}, headers={"Retry-After": "30"}),
        Limits(task_timeout_seconds=10),
    )
    monkeypatch.setattr("hacklab.providers.time.sleep", lambda _: pytest.fail("must not wait"))
    with pytest.raises(BudgetExceeded, match="task_time_budget_exhausted_before_retry"):
        provider.complete([], {})
    assert budget.calls == 1


def test_retry_after_is_honored_without_capping_to_two_seconds(receipt, monkeypatch):
    clock = [0.0]
    sleeps = []
    count = [0]

    def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay

    def handler(request):
        count[0] += 1
        if count[0] == 1:
            return httpx.Response(429, json={}, headers={"Retry-After": "4"})
        return httpx.Response(200, json=completion())

    monkeypatch.setattr("hacklab.providers.time.monotonic", lambda: clock[0])
    monkeypatch.setattr("hacklab.providers.time.sleep", sleep)
    provider, _ = small(receipt, handler)
    provider.complete([], {})
    assert sum(sleeps) == 4
    assert max(sleeps) <= 1
    assert count[0] == 2


@pytest.mark.parametrize("value", [True, -0.1, 1.1, "0.9", float("nan")])
def test_invalid_jev_probability_is_rejected(receipt, value):
    # json.dumps allows NaN specifically to exercise defensive provider parsing.
    payload = json.dumps({"answers": {"claim": {"type": "noul", "noul": value}}, "usage": {}})
    limits = Limits()
    provider = JevProvider(
        JevConfig(),
        limits,
        Budget(limits),
        *receipt,
        client=httpx.Client(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, text=payload))
        ),
    )
    with pytest.raises(ProviderError, match="jev_probability_invalid"):
        provider.judge({}, {"claim": {"type": "noul", "instructions": "Check."}})
    assert len(receipt[0].calls(receipt[1])) == 1


@pytest.mark.parametrize(
    "content",
    [
        '{"action":"final"}',
        '```json\n{"action":"final"}\n```',
        '```\n{"action":"final"}\n```',
        'Here is my decision:\n{"action":"final"}\nI hope this helps.',
        '<think>The user wants {"x": 1} maybe.</think>\n{"action":"final"}',
        'Sure. [1, 2] then {"action":"final"} and {"action":"read"}',
    ],
)
def test_decision_is_recovered_from_wrapped_model_output(content):
    from hacklab.providers import decision_object

    assert decision_object(content) == {"action": "final"}


@pytest.mark.parametrize("content", ["", "no json here", "[1, 2, 3]", '"text"', "{broken"])
def test_output_without_a_json_object_is_a_repairable_model_error(content):
    from hacklab.providers import decision_object

    with pytest.raises(ModelOutputError):
        decision_object(content)


def test_endpoint_specific_token_parameter_and_omitted_temperature(receipt):
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=completion())

    provider, _ = small(
        receipt, handler, max_tokens_parameter="max_completion_tokens", temperature="omit"
    )
    provider.complete([{"role": "user", "content": "x"}], {})
    assert bodies[0]["max_completion_tokens"] == Limits().max_output_tokens
    assert "max_tokens" not in bodies[0] and "temperature" not in bodies[0]
    default, _ = small(receipt, handler)
    default.complete([{"role": "user", "content": "x"}], {})
    assert bodies[1]["max_tokens"] == Limits().max_output_tokens and bodies[1]["temperature"] == 0


def test_gateway_specific_auth_and_request_fields_come_from_configuration(receipt):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=completion())

    provider, _ = small(
        receipt,
        handler,
        auth_header="api-key",
        auth_scheme="",
        extra_body={
            "chat_template_kwargs": {"enable_thinking": False},
            "seed": 7,
            "model": "must-not-override",
        },
    )
    provider.complete([{"role": "user", "content": "JSON"}], {})
    body = json.loads(seen[0].content)
    assert seen[0].headers["api-key"] == "synthetic-test-key"
    assert "authorization" not in seen[0].headers
    assert body["chat_template_kwargs"] == {"enable_thinking": False} and body["seed"] == 7
    assert body["model"] == "event-small-model"


def test_reply_spent_on_hidden_reasoning_is_named_and_token_details_are_kept(receipt):
    payload = {
        "choices": [
            {"message": {"content": "", "reasoning_content": "thinking…"}, "finish_reason": "stop"}
        ],
        "usage": {
            "prompt_tokens": 900,
            "completion_tokens": 400,
            "prompt_tokens_details": {"cached_tokens": 800},
            "completion_tokens_details": {"reasoning_tokens": 390},
        },
    }
    provider, _ = small(receipt, lambda request: httpx.Response(200, json=payload))
    with pytest.raises(ModelOutputError, match="^model_returned_reasoning_only$"):
        provider.complete([], {})
    call = receipt[0].calls(receipt[1])[0]
    assert call["metadata"]["cached_tokens"] == 800
    assert call["metadata"]["reasoning_tokens"] == 390
    parts = completion()
    parts["choices"][0]["message"]["content"] = [{"type": "text", "text": '{"action":"final"}'}]
    provider, _ = small(receipt, lambda request: httpx.Response(200, json=parts))
    assert provider.complete([], {}) == {"action": "final"}


def cached(receipt, tmp_path, handler, mode="readwrite", salt="", allowance=100, **config):
    tracker, run_id = receipt
    limits = Limits()
    return SmallModelProvider(
        ModelConfig(
            provider="openai",
            base_url="http://127.0.0.1:1234/v1",
            model="event-small-model",
            input_usd_per_million=1,
            output_usd_per_million=2,
            **config,
        ),
        limits,
        Budget(limits),
        tracker,
        run_id,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        cache=ResponseCache(tmp_path / "private" / "cache.sqlite", mode),
        cache_salt=salt,
        spend=DevSpend(DevBudget(max_calls=allowance), tracker),
    )


def test_cache_replays_identical_requests_without_spending(receipt, tmp_path):
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=completion({"action": "final", "n": len(requests)}))

    ask = [{"role": "user", "content": "same question"}]
    first = cached(receipt, tmp_path, handler).complete(ask, {})
    again = cached(receipt, tmp_path, handler).complete(ask, {})
    assert first == again == {"action": "final", "n": 1} and len(requests) == 1
    live, replay = receipt[0].calls(receipt[1])
    assert live["status"] == "ok" and replay["status"] == "cache_hit"
    assert replay["metadata"]["cache_hit"] is True and replay["input_tokens"] == 20
    summary = receipt[0].summary(receipt[1])
    # The replay keeps its measured usage, so per-task cost stays what a live run costs.
    assert summary["calls"] == 2 and summary["cache_hits"] == 1
    assert summary["cost_usd"] == pytest.approx(2 * 0.00004)
    # Only the live request counts against the team's allowance.
    assert receipt[0].spend() == {
        "calls": 1,
        "tokens": 30,
        "usd": pytest.approx(0.00004),
        "unknown_cost_calls": 0,
    }
    # A different prompt, model setting or repetition is a different request.
    cached(receipt, tmp_path, handler).complete([{"role": "user", "content": "other"}], {})
    cached(receipt, tmp_path, handler, salt="1").complete(ask, {})
    cached(receipt, tmp_path, handler, temperature=0.5).complete(ask, {})
    assert len(requests) == 4
    mode = stat.S_IMODE((tmp_path / "private" / "cache.sqlite").stat().st_mode)
    assert mode == 0o600


def test_replay_mode_never_sends_and_a_reply_needing_repair_replays_as_such(receipt, tmp_path):
    def invalid(request):
        payload = completion()
        payload["choices"][0]["message"]["content"] = "not json at all"
        return httpx.Response(200, json=payload)

    ask = [{"role": "user", "content": "q"}]
    with pytest.raises(ModelOutputError):
        cached(receipt, tmp_path, invalid).complete(ask, {})

    def offline(request):
        raise AssertionError("replay mode must not reach the network")

    with pytest.raises(ModelOutputError, match="model_content_must_be_json_text"):
        cached(receipt, tmp_path, offline, mode="replay").complete(ask, {})
    with pytest.raises(ProviderError, match="^cache_miss_in_replay_mode$"):
        cached(receipt, tmp_path, offline, mode="replay").complete([], {})
    cache = ResponseCache(tmp_path / "private" / "cache.sqlite", "readwrite")
    assert cache.stats()["entries"] == 1 and cache.clear() == 1 and cache.stats()["entries"] == 0
    with pytest.raises(ValueError):
        ResponseCache(tmp_path / "private" / "cache.sqlite", "off")


def test_failed_replies_are_not_cached(receipt, tmp_path):
    seen = []

    def handler(request):
        seen.append(1)
        return httpx.Response(401, json={"error": "denied"})

    for _ in range(2):
        with pytest.raises(ProviderError, match="provider_http_401"):
            cached(receipt, tmp_path, handler).complete([], {})
    assert len(seen) == 2


def test_development_allowance_stops_live_requests_across_runs(receipt, tmp_path):
    tracker, run_id = receipt
    seen = []

    def handler(request):
        seen.append(1)
        return httpx.Response(200, json=completion())

    def ask(text):
        provider = cached(receipt, tmp_path, handler, allowance=3)
        return provider.complete([{"role": "user", "content": text}], {})

    for index in range(3):
        ask(str(index))
    with pytest.raises(BudgetExceeded, match="^development_budget_exhausted$"):
        ask("new")
    assert len(seen) == 3
    # What was already paid for still replays.
    assert ask("0") == {"action": "final"}
    spend = DevSpend(DevBudget(max_tokens=10_000, max_usd=0.00015), tracker)
    spend.check()
    spend.add(20, 10, 0.00004)
    with pytest.raises(BudgetExceeded):
        spend.check()


def test_optimizer_stops_http_retries_as_soon_as_cost_is_unknown(receipt, tmp_path, monkeypatch):
    monkeypatch.setenv("HACKLAB_OPTIMIZATION_UNKNOWN_BASELINE", "0")
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(500, json={"error": "temporary"})

    provider = cached(receipt, tmp_path, handler)
    with pytest.raises(BudgetExceeded, match="^optimization_cost_unknown$"):
        provider.complete([], {})
    assert len(requests) == 1
    assert receipt[0].spend()["unknown_cost_calls"] == 1


def test_stage_receipts_follow_live_and_replayed_caller_without_leaking_context(receipt, tmp_path):
    from hacklab.providers import provider_stage

    def handler(request):
        return httpx.Response(200, json=completion())

    with provider_stage("optimizer_analyst"):
        cached(receipt, tmp_path, handler).complete([], {})
    with provider_stage("responder"):
        cached(receipt, tmp_path, handler).complete([], {})
    cached(receipt, tmp_path, handler).complete([{"role": "user", "content": "new"}], {})
    first, second, third = receipt[0].calls(receipt[1])
    assert first["metadata"]["stage"] == "optimizer_analyst"
    assert second["metadata"]["stage"] == "responder" and second["metadata"]["cache_hit"]
    assert "stage" not in third["metadata"]


def test_make_providers_builds_cache_and_allowance_from_configuration(receipt, tmp_path):
    tracker, run_id = receipt
    config = Config.model_validate(
        {
            "model": {"provider": "openai", "base_url": "http://localhost/v1", "model": "m"},
            "jev": {"enabled": True},
            "cache": {"mode": "replay", "path": str(tmp_path / "c" / "cache.sqlite")},
            "budget": {"max_calls": 5},
        }
    )
    small_model, jev = make_providers(config, Budget(config.limits), tracker, run_id, "3")
    try:
        assert small_model.cache is jev.cache and small_model.cache.mode == "replay"
        assert small_model.cache_salt == "3" and small_model.spend.budget.max_calls == 5
    finally:
        small_model.close()
        jev.close()
    plain = Config.model_validate(
        {"model": {"provider": "openai", "base_url": "http://localhost/v1", "model": "m"}}
    )
    only, none = make_providers(plain, Budget(plain.limits), tracker, run_id)
    only.close()
    assert only.cache is None and only.spend is None and none is None


def test_jev_choice_returns_option_and_confidence(receipt):
    tracker, run_id = receipt
    limits = Limits()
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        answer = {
            "type": "choice",
            "choice": "decode",
            "confidence": 0.7,
            "probabilities": {"decode": 0.8, "timeline": 0.2},
        }
        return httpx.Response(
            200,
            json={
                "model": "jev-1.14.0",
                "answers": {"choice": answer},
                "usage": {"input_tokens": 40, "output_tokens": 2},
            },
        )

    jev = JevProvider(
        JevConfig(enabled=True),
        limits,
        Budget(limits),
        tracker,
        run_id,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    criteria = {"decode": "Asks what a payload contains", "timeline": "Asks when or in what order"}
    assert jev.choose(
        {"task": "Decode channel ops-5"}, "Which kind of task is `task`?", criteria
    ) == (
        "decode",
        0.7,
    )
    assert seen[0]["questions"]["choice"] == {
        "type": "choice",
        "instructions": "Which kind of task is `task`?",
        "criteria": criteria,
    }
    with pytest.raises(ProviderError, match="jev_choice_requires"):
        jev.choose({}, "Which?", {"only": "one"})

    def wrong(request):
        answer = {"type": "choice", "choice": "invented", "confidence": 0.9, "probabilities": {}}
        return httpx.Response(
            200,
            json={
                "model": "j",
                "answers": {"choice": answer},
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        )

    jev.client = httpx.Client(transport=httpx.MockTransport(wrong))
    with pytest.raises(ProviderError, match="^jev_choice_invalid$"):
        jev.choose({}, "Which?", criteria)


def test_retries_wait_longer_each_time_and_count_against_the_request_budget(receipt, monkeypatch):
    clock = [0.0]
    sleeps = []
    count = [0]

    def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay

    def handler(request):
        count[0] += 1
        if count[0] <= 3:
            return httpx.Response(429 if count[0] == 1 else 503, json={})
        return httpx.Response(200, json=completion())

    monkeypatch.setattr("hacklab.providers.RETRY_PAUSES", (0.5, 1.0, 2.0, 4.0))
    monkeypatch.setattr("hacklab.providers.time.monotonic", lambda: clock[0])
    monkeypatch.setattr("hacklab.providers.time.sleep", sleep)
    # A repair turn costs tokens and stays at one; waiting out a rate limit is nearly free.
    provider, budget = small(receipt, handler, Limits(max_retries=1, http_retries=3))
    assert provider.complete([], {}) == {"action": "final"}
    assert count[0] == 4 and budget.calls == 4
    # 0.5 s, 1 s and 2 s, slept in steps of at most one second.
    assert sum(sleeps) == 3.5 and max(sleeps) <= 1
    statuses = [call["status"] for call in receipt[0].calls(receipt[1])]
    assert statuses == ["http_429", "http_503", "http_503", "ok"]
    # Without the setting, a request is retried as often as a reply is repaired.
    count[0] = 0
    provider, budget = small(receipt, handler, Limits(max_retries=1))
    with pytest.raises(ProviderError, match="^provider_http_503$"):
        provider.complete([], {})
    assert budget.calls == 2


def test_the_end_of_the_run_bounds_every_request(receipt):
    now = [100.0]
    limits = Limits(task_timeout_seconds=300)
    budget = Budget(limits, clock=lambda: now[0], deadline=130.0)
    # The task has five minutes, the run thirty seconds: the nearer end counts.
    assert budget.remaining_seconds() == 30
    budget.reserve({}, 1, None, None)
    now[0] = 130.0
    with pytest.raises(BudgetExceeded, match="^run_deadline_reached$"):
        budget.reserve({}, 1, None, None)
    assert budget.calls == 1
    assert Budget(limits, clock=lambda: now[0]).remaining_seconds() == 300


@pytest.mark.parametrize(
    ("base_url", "endpoint"),
    [
        ("https://host/v1", "https://host/v1/chat/completions"),
        ("https://host/v1/", "https://host/v1/chat/completions"),
        ("http://127.0.0.1:8080", "http://127.0.0.1:8080/chat/completions"),
        # Pasted complete, as it stands in most documentation.
        ("https://host/v1/chat/completions", "https://host/v1/chat/completions"),
        ("https://host/api/chat", "https://host/api/chat"),
        # A gateway that carries its API version in the query string.
        (
            "https://host/openai/deployments/small/chat/completions?api-version=2024-06-01",
            "https://host/openai/deployments/small/chat/completions?api-version=2024-06-01",
        ),
        ("https://host/route?key=value", "https://host/route?key=value"),
    ],
)
def test_the_endpoint_is_the_prefix_plus_the_chat_route_unless_already_complete(
    receipt, base_url, endpoint
):
    assert chat_endpoint(base_url) == endpoint
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, json=completion())

    tracker, run_id = receipt
    limits = Limits()
    provider = SmallModelProvider(
        ModelConfig(provider="openai", base_url=base_url, model="m"),
        limits,
        Budget(limits),
        tracker,
        run_id,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    provider.complete([], {})
    assert seen == [endpoint]


def kit(receipt, call, limits=None, **options):
    tracker, run_id = receipt
    limits = limits or Limits()
    budget = Budget(limits)
    config = ModelConfig(
        provider="openai", model="kit-model", input_usd_per_million=1, output_usd_per_million=2
    )
    return FunctionModel(call, config, limits, budget, tracker, run_id, **options), budget


def test_a_kit_function_is_metered_cached_and_bounded_like_the_http_adapter(receipt, tmp_path):
    asked = []

    def chat(messages):
        asked.append(messages)
        return completion({"action": "final", "n": len(asked)})

    ask = [{"role": "user", "content": "same question"}]
    cache = {"cache": ResponseCache(tmp_path / "private" / "cache.sqlite", "readwrite")}
    spend = DevSpend(DevBudget(max_calls=2), receipt[0])
    model, budget = kit(receipt, chat, spend=spend, **cache)
    assert model.complete(ask, {}) == {"action": "final", "n": 1}
    again, _ = kit(receipt, chat, spend=spend, **cache)
    assert again.complete(ask, {}) == {"action": "final", "n": 1} and len(asked) == 1
    live, replay = receipt[0].calls(receipt[1])
    assert (live["status"], live["input_tokens"], live["output_tokens"]) == ("ok", 20, 10)
    assert live["model"] == "kit-model" and replay["status"] == "cache_hit"
    # Only the live call counts against the team's allowance.
    assert receipt[0].spend()["calls"] == 1 and budget.calls == 1
    # A reply the harness cannot read is a repairable model error, not a crash.
    for reply in (None, 7, {"choices": []}, "no json here"):
        broken, _ = kit(receipt, lambda messages, reply=reply: reply)
        with pytest.raises(ModelOutputError):
            broken.complete(ask, {})
    truncated, _ = kit(receipt, lambda messages: completion(finish="length"))
    with pytest.raises(ModelOutputError, match="^model_output_truncated$"):
        truncated.complete(ask, {})
    # In replay mode nothing is asked.
    replay_only, _ = kit(
        receipt,
        lambda messages: pytest.fail("must not call"),
        cache=ResponseCache(tmp_path / "private" / "cache.sqlite", "replay"),
    )
    assert replay_only.complete(ask, {}) == {"action": "final", "n": 1}
    with pytest.raises(ProviderError, match="^cache_miss_in_replay_mode$"):
        replay_only.complete([{"role": "user", "content": "new"}], {})


def test_a_kit_function_that_hangs_or_fails_is_given_up_within_bounds(receipt):
    import threading

    release = threading.Event()
    started = []

    def hangs(messages):
        started.append(1)
        release.wait(30)
        return completion()

    # No timeout of its own: the harness stops waiting, tries once more, gives up.
    model, budget = kit(receipt, hangs, Limits(timeout_seconds=0.05, http_retries=4))
    try:
        with pytest.raises(ProviderError, match="^provider_timeout$"):
            model.complete([], {})
    finally:
        release.set()
    assert len(started) == 2 and budget.calls == 2
    assert [call["status"] for call in receipt[0].calls(receipt[1])] == ["timeout", "timeout"]

    attempts = []

    def flaky(messages):
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError("rate limited, with a private detail")
        return "```json\n" + json.dumps({"action": "final"}) + "\n```"

    model, budget = kit(receipt, flaky, Limits(http_retries=3))
    assert model.complete([], {}) == {"action": "final"} and len(attempts) == 3
    down, _ = kit(receipt, lambda messages: 1 / 0, Limits(http_retries=1))
    with pytest.raises(ProviderError, match="^kit_model_call_failed$"):
        down.complete([], {})
    # Usage the kit did not report stays unknown instead of being guessed.
    assert receipt[0].calls(receipt[1])[-1]["input_tokens"] is None
