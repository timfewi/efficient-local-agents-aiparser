from pathlib import Path

import pytest
from pydantic import ValidationError

from hacklab.config import Config, GuardConfig, Limits, load_config, read_secret
from hacklab.models import Task


def test_cost_cap_requires_prices_for_each_live_provider():
    with pytest.raises(ValidationError):
        Config.model_validate({"model": {"provider": "openai"}, "limits": {"max_cost_usd": 0.01}})
    with pytest.raises(ValidationError):
        Config.model_validate(
            {
                "model": {
                    "provider": "openai",
                    "input_usd_per_million": 0.1,
                    "output_usd_per_million": 0.1,
                },
                "jev": {"enabled": True},
                "limits": {"max_cost_usd": 0.01},
            }
        )


def test_env_override_and_secret_file(tmp_path, monkeypatch):
    path = tmp_path / "model.toml"
    path.write_text('[model]\nprovider="openai"\n')
    monkeypatch.setenv("SMALL_MODEL_NAME", "event-model")
    assert load_config(path).model.model == "event-model"
    # A gateway for Jev inside the container needs no new configuration file.
    assert load_config(path).jev.base_url == "https://api.typesafe.ai/v1/systemone"
    monkeypatch.setenv("TYPESAFE_BASE_URL", "http://gateway:8080/v1/systemone")
    assert load_config(path).jev.base_url == "http://gateway:8080/v1/systemone"
    secret = tmp_path / "key"
    secret.write_text("fake-test-key\n")
    monkeypatch.setenv("EXAMPLE_KEY_FILE", str(secret))
    assert read_secret("EXAMPLE_KEY") == "fake-test-key"


def test_task_refuses_reference_labels():
    with pytest.raises(ValidationError):
        Task.model_validate({"id": "x", "question": "Question", "expected": "leak"})


def test_every_shipped_profile_is_valid_and_ships_with_cache_and_allowance_off(monkeypatch):
    profiles = sorted((Path(__file__).parents[1] / "configs").glob("*.toml"))
    names = {path.stem for path in profiles}
    assert names == {
        "baseline",
        "jev-select",
        "live",
        "mock",
        "openrouter",
        "openrouter-jev",
        "openrouter-pipeline",
        "practice",
    }
    for path in profiles:
        config = load_config(path)
        assert config.cache.mode == "off", path.name
        if path.stem.startswith("openrouter"):
            # The rehearsal profile guards a small temporary credit.
            assert config.budget.max_usd is not None
            continue
        # What is submitted must neither replay old replies nor stop on a development limit.
        assert config.budget.model_dump() == {
            "max_calls": None,
            "max_tokens": None,
            "max_usd": None,
        }
    monkeypatch.setenv("HACKLAB_CACHE_MODE", "replay")
    assert load_config(profiles[0]).cache.mode == "replay"


CONFIGS = Path(__file__).parents[1] / "configs"


def test_the_candidate_profile_is_the_measured_one():
    live = load_config(CONFIGS / "live.toml")
    measured = load_config(CONFIGS / "openrouter.toml")
    # The numbers in docs/benchmarks.md come from openrouter.toml. The profile
    # that is submitted once had tighter limits than the one that was measured,
    # and lost whole task categories to its own token budget.
    assert live.limits == measured.limits
    assert live.agent.model_dump(exclude={"playbooks"}) == measured.agent.model_dump(
        exclude={"playbooks"}
    )
    scenario = {"allowed_actions", "protected_targets"}
    assert live.guard.model_dump(exclude=scenario) == measured.guard.model_dump(exclude=scenario)
    assert live.model.response_format == measured.model.response_format
    # Jev stays off until a benchmark on the day's cases shows a gain.
    assert live.jev.enabled is False
    # A profile written from scratch starts from the same limits.
    assert live.limits.model_dump(exclude={"http_retries"}) == Limits().model_dump(
        exclude={"http_retries"}
    )
    assert live.guard.max_actions == GuardConfig().max_actions
    # The Jev variants differ from their base in the [jev] table only.
    for variant, base in (("jev-select", "live"), ("openrouter-jev", "openrouter")):
        with_jev = load_config(CONFIGS / f"{variant}.toml")
        without = load_config(CONFIGS / f"{base}.toml")
        assert with_jev.jev.enabled and not without.jev.enabled
        assert with_jev.model_dump(exclude={"jev"}) == without.model_dump(exclude={"jev"})


def test_the_candidate_profile_finds_its_solvers_and_recipes_wherever_it_runs(
    tmp_path, monkeypatch
):
    from hacklab import playbooks
    from hacklab.agent import skill_files

    live = load_config(CONFIGS / "live.toml")
    # Both are named by package, not by path: the image's working directory
    # and the team's laptops need not agree.
    monkeypatch.chdir(tmp_path)
    assert isinstance(playbooks.load(live.agent.playbooks), playbooks.Playbooks)
    assert len(skill_files(live.agent.skills)) >= 2


def test_guard_and_agent_settings_are_validated():
    with pytest.raises(ValidationError):
        Config.model_validate({"guard": {"injection": "sometimes"}})
    with pytest.raises(ValidationError):
        Config.model_validate({"agent": {"playbooks": "not a module path"}})
    with pytest.raises(ValidationError):
        Config.model_validate({"model": {"auth_header": "bad header"}})
    with pytest.raises(ValidationError):
        Config.model_validate({"model": {"provider": "openai"}, "budget": {"max_usd": 5}})
    config = Config.model_validate(
        {"agent": {"playbooks": "team.playbooks:registry", "tools": ["read"]}}
    )
    assert config.agent.tools == ["read"] and config.guard.injection == "flag"


def test_pipeline_profile_is_a_single_controlled_change():
    profiles = Path(__file__).parents[1] / "configs"
    baseline = load_config(profiles / "openrouter.toml").model_dump()
    candidate = load_config(profiles / "openrouter-pipeline.toml").model_dump()
    assert baseline["agent"]["workflow"] == "loop"
    assert candidate["agent"]["workflow"] == "pipeline"
    candidate["agent"]["workflow"] = "loop"
    assert candidate == baseline


@pytest.mark.parametrize("rounds", [0, 4])
def test_pipeline_rounds_have_a_hard_bound(rounds):
    with pytest.raises(ValidationError):
        Config.model_validate({"agent": {"pipeline_rounds": rounds}})
