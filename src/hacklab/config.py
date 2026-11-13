"""Non-secret TOML configuration; credentials are resolved only at runtime."""

import os
import tomllib
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from hacklab.models import StrictModel

DEFAULT_TOOLS = ["search", "read", "table", "after", "calculate", "decode", "iocs", "graph"]


class ModelConfig(StrictModel):
    provider: Literal["mock", "openai"] = "mock"
    base_url: str = ""
    model: str = ""
    api_key_env: str = "SMALL_MODEL_API_KEY"
    # Gateways differ in the header that carries the key; an empty scheme sends
    # the bare key, for example with auth_header = "api-key".
    auth_header: str = Field(default="Authorization", pattern=r"^[A-Za-z0-9-]{1,64}$")
    auth_scheme: str = Field(default="Bearer", pattern=r"^[A-Za-z0-9-]{0,32}$")
    response_format: Literal["json_schema", "json_object", "none"] = "json_object"
    # Endpoints differ in how the output allowance is named and whether they
    # accept a temperature at all; "omit" leaves the field out of the request.
    max_tokens_parameter: Literal["max_tokens", "max_completion_tokens"] = "max_tokens"
    temperature: Annotated[float, Field(ge=0, le=2)] | Literal["omit"] = 0.0
    # Merged into every request body. This is where a reasoning model's
    # thinking is switched off, for example
    # extra_body = { chat_template_kwargs = { enable_thinking = false } }.
    extra_body: dict[str, Any] = Field(default_factory=dict)
    input_usd_per_million: float | None = Field(default=None, ge=0)
    output_usd_per_million: float | None = Field(default=None, ge=0)


class JevConfig(StrictModel):
    enabled: bool = False
    base_url: str = "https://api.typesafe.ai/v1/systemone"
    model: str = "jev-1.14.0"
    api_key_env: str = "TYPESAFE_API_KEY"
    input_usd_per_million: float | None = Field(default=None, ge=0)
    output_usd_per_million: float | None = Field(default=None, ge=0)
    threshold: float = Field(default=0.8, ge=0, le=1)
    # Optional pre-filter: Jev drops preloaded passages that are clearly
    # irrelevant before the generator pays for them. Keeps the best passage.
    select: bool = False
    select_threshold: float = Field(default=0.3, ge=0, le=1)


class Limits(StrictModel):
    """Per-task bounds. The defaults are the measured candidate profile, configs/live.toml:

    a profile written from scratch on the day starts from values that were
    run, not from ones that cut multi-step tasks short.
    """

    max_steps: int = Field(default=8, ge=1, le=30)
    max_calls: int = Field(default=16, ge=1, le=100)
    # Repair turns after an invalid model reply, which cost tokens.
    max_retries: int = Field(default=1, ge=0, le=3)
    # Attempts after a rate limit, a server error or a lost connection, with a
    # growing pause. Waiting is nearly free and a failed task scores nothing,
    # so this may exceed max_retries. Unset, it equals max_retries.
    http_retries: int | None = Field(default=None, ge=0, le=6)
    timeout_seconds: float = Field(default=60, gt=0, le=120)
    task_timeout_seconds: float = Field(default=300, gt=0, le=1800)
    max_context_chars: int = Field(default=24000, ge=2000, le=200000)
    # One tool result as the model sees it. Every result is sent again with
    # each later step, so this is the main lever on input tokens.
    max_observation_chars: int = Field(default=4000, ge=500, le=20000)
    max_output_tokens: int = Field(default=3000, ge=128, le=8192)
    # Checked before each request against the request's size in bytes plus the
    # output allowance, so it must hold several whole prompts.
    max_total_tokens: int = Field(default=120000, ge=128)
    max_cost_usd: float | None = Field(default=None, gt=0)


class AgentConfig(StrictModel):
    # The staged workflow batches read-only investigation, then gives a fresh
    # responder the original task and executed results. Both use the same model
    # and task budget; the ordinary loop remains the default.
    workflow: Literal["loop", "pipeline"] = "loop"
    pipeline_rounds: int = Field(default=2, ge=1, le=3)
    # Search results for the question placed in the first prompt, so that an
    # answerable task needs one generator call instead of a search turn first.
    preload_results: int = Field(default=0, ge=0, le=20)
    # One line per task document (size and column names) in the first prompt:
    # the model can then query a table without a discovery turn.
    inventory: bool = True
    # Short prose documents, such as a runbook or policy, are shown in full in
    # the first prompt when they have at most this many lines. 0 switches it off.
    preload_documents_under: int = Field(default=0, ge=0, le=200)
    # Every listed tool costs prompt tokens on every call; list only what the
    # scenario needs. Tools registered by code are always offered.
    tools: list[str] = Field(default_factory=lambda: list(DEFAULT_TOOLS), max_length=20)
    # How many values of a list result (distinct, group, reach) are printed. The
    # full list stays available under its result ID for the final answer.
    list_preview: int = Field(default=12, ge=1, le=100)
    # Above zero, the model writes a short "thought" before its action
    # (schema-guided reasoning). It costs output tokens; measure before keeping.
    thought_chars: int = Field(default=0, ge=0, le=2000)
    # What happens to an answer whose evidence or actions still fail validation
    # after the repair allowance: abstain, or return what is verifiable.
    on_unverified: Literal["abstain", "answer"] = "abstain"
    # Directory of skill files: short recipes for one kind of task each. A file
    # starts with "match: <regex>"; when the task text matches, the rest is
    # added to the first prompt. Code picks the skill, never the evidence.
    # Either a path, or "package:folder" for a folder inside an installed
    # package, which is found wherever the working directory is.
    skills: str = ""
    # "package.module:attribute" of a hacklab.playbooks.Playbooks instance:
    # deterministic solvers that answer a recognised task without a model call.
    playbooks: str = Field(default="", pattern=r"^([A-Za-z_][\w.]*:[A-Za-z_]\w*)?$")
    # How table aggregates read numbers such as 1.234,56: "auto" infers the
    # convention per column and reports it; set it once the data is known.
    decimal_separator: Literal["auto", "point", "comma"] = "auto"


class GuardConfig(StrictModel):
    """Independent layers; each can be switched off alone if it misfires on the day."""

    # Instruction-like text inside evidence: "flag" marks the row, "withhold"
    # replaces its text. The row and its flag stay citable either way.
    injection: Literal["off", "flag", "withhold"] = "flag"
    # Tokens, keys and long encoded blobs are shown as short [[kind:id]]
    # placeholders. Answers and tool arguments are expanded back by code.
    compact_secrets: bool = True
    # Show what an encoded blob decodes to next to its placeholder.
    decode_previews: bool = True
    # Containment actions: accepted types (empty accepts any type) and targets
    # that must never be acted on. A target must occur in evidence or the task.
    allowed_actions: list[str] = Field(default_factory=list, max_length=100)
    protected_targets: list[str] = Field(default_factory=list, max_length=200)
    require_grounded_targets: bool = True
    # A brake against runaway containment. A swarm incident needs one action
    # per compromised agent, token and dataset.
    max_actions: int = Field(default=200, ge=0, le=2000)


class CacheConfig(StrictModel):
    """Development only: replays identical requests instead of paying again."""

    mode: Literal["off", "readwrite", "replay"] = "off"
    path: str = ".state/cache.sqlite"


class DevBudget(StrictModel):
    """The team's allowance across all runs in one tracking database; unset means unlimited."""

    max_calls: int | None = Field(default=None, ge=1)
    max_tokens: int | None = Field(default=None, ge=1)
    max_usd: float | None = Field(default=None, gt=0)


class Config(StrictModel):
    model: ModelConfig = Field(default_factory=ModelConfig)
    jev: JevConfig = Field(default_factory=JevConfig)
    agent: AgentConfig = Field(default_factory=AgentConfig)
    guard: GuardConfig = Field(default_factory=GuardConfig)
    limits: Limits = Field(default_factory=Limits)
    cache: CacheConfig = Field(default_factory=CacheConfig)
    budget: DevBudget = Field(default_factory=DevBudget)

    @model_validator(mode="after")
    def priced_budget(self):
        providers = [self.model] + ([self.jev] if self.jev.enabled else [])
        unpriced = self.model.provider != "mock" and any(
            p.input_usd_per_million is None or p.output_usd_per_million is None for p in providers
        )
        if unpriced and (self.limits.max_cost_usd is not None or self.budget.max_usd is not None):
            raise ValueError("A cost budget requires explicit prices for every enabled provider")
        return self


def load_config(path: Path | None = None) -> Config:
    data = tomllib.loads(path.read_text(encoding="utf-8")) if path else {}
    model = data.setdefault("model", {})
    for env, key in [("SMALL_MODEL_BASE_URL", "base_url"), ("SMALL_MODEL_NAME", "model")]:
        if os.environ.get(env):
            model[key] = os.environ[env]
    # The organizers may route Jev through their own gateway inside the container.
    if os.environ.get("TYPESAFE_BASE_URL"):
        data.setdefault("jev", {})["base_url"] = os.environ["TYPESAFE_BASE_URL"]
    if os.environ.get("HACKLAB_CACHE_MODE"):
        data.setdefault("cache", {})["mode"] = os.environ["HACKLAB_CACHE_MODE"]
    return Config.model_validate(data)


def read_secret(env_name: str) -> str:
    """Support secret-file channels without placing secret values in Nix or arguments."""
    if file_name := os.environ.get(env_name + "_FILE"):
        return Path(file_name).read_text(encoding="utf-8").strip()
    return os.environ.get(env_name, "").strip()
