"""Bounded development optimization; labels and document bodies never reach its analyst.

Each proposal changes one whitelisted setting. An actual development benchmark
and a deterministic Pareto check decide promotion. This is a development tool,
never a competition-task solver or an unbounded background service.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import signal
import subprocess
import tempfile
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from pydantic import ValidationError, model_validator

from hacklab.benchmark import benchmark, dataset_digest, load_cases
from hacklab.config import Config, load_config
from hacklab.models import StrictModel
from hacklab.providers import Budget, DevSpend, SmallModelProvider, provider_stage
from hacklab.tracking import Tracker

FIELDS = {
    "agent.workflow": ("loop", "pipeline"),
    "agent.preload_results": (0, 10),
    "agent.inventory": (False, True),
    "agent.preload_documents_under": (0, 80),
    "agent.list_preview": (1, 20),
    "limits.max_observation_chars": (500, 8000),
}
CHECKS = {
    "status",
    "exact_answer",
    "answer_set",
    "actions",
    "contains",
    "excludes",
    "required_documents",
    "grounded_quotes",
}


class MeasurementUncertain(TimeoutError):
    """An owned child was killed; an unreceipted external attempt is possible."""

    def __init__(self, message: str, *, timed_out: bool = True):
        super().__init__(message)
        self.timed_out = timed_out


class HoldoutNotDistinct(ValueError):
    """The supposed hold-out has the development corpus's exact digest."""


class HoldoutAlreadyUsed(ValueError):
    """This database already reserved the hold-out, even under another source HEAD."""


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _digest(value: Any) -> str:
    # Pydantic defaults may hold 60 while a validated round trip holds 60.0.
    # These are the same effective configuration; booleans and strings are not.
    def numbers(item: Any) -> Any:
        if type(item) is float and math.isfinite(item) and item.is_integer():
            return int(item)
        if isinstance(item, dict):
            return {key: numbers(entry) for key, entry in item.items()}
        if isinstance(item, (list, tuple)):
            return [numbers(entry) for entry in item]
        return item

    return hashlib.sha256(_json(numbers(value)).encode()).hexdigest()


class ConfigEdit(StrictModel):
    field: Literal[
        "agent.workflow",
        "agent.preload_results",
        "agent.inventory",
        "agent.preload_documents_under",
        "agent.list_preview",
        "limits.max_observation_chars",
    ]
    value: Any
    hypothesis: Literal[
        "batch_queries", "reduce_context", "preload_evidence", "adjust_inventory", "reduce_copying"
    ]

    @model_validator(mode="after")
    def allowed_value(self):
        bounds = FIELDS[self.field]
        if self.field == "agent.workflow":
            valid = type(self.value) is str and self.value in bounds
        elif self.field == "agent.inventory":
            valid = type(self.value) is bool
        else:
            valid = type(self.value) is int and bounds[0] <= self.value <= bounds[1]
        if not valid:
            raise ValueError("value_outside_allowed_domain")
        return self


def apply_edit(config: Config, edit: ConfigEdit) -> Config:
    values = config.model_dump()
    section, key = edit.field.split(".")
    if values[section][key] == edit.value:
        raise ValueError("setting_unchanged")
    values[section][key] = edit.value
    return Config.model_validate(values)


def safe_config(config: Config) -> dict:
    """Only tunable parameters and digests; no endpoint, auth header or key material."""
    values = config.model_dump()
    fixed = config.model_dump()
    result: dict[str, Any] = {"agent": {}, "limits": {}}
    for field in FIELDS:
        section, key = field.split(".")
        result[section][key] = values[section][key]
        fixed[section].pop(key)
    fixed.pop("budget")
    fixed.pop("cache")
    result["fixed_config_sha256"] = _digest(fixed)
    result["candidate_sha256"] = _digest(result)
    result["config_sha256"] = _digest(values)
    return result


def restore_config(base: Config, saved: dict) -> Config:
    values = base.model_dump()
    for field in FIELDS:
        section, key = field.split(".")
        edit = ConfigEdit(field=field, value=saved[section][key], hypothesis="reduce_context")
        values[section][key] = edit.value
    return Config.model_validate(values)


def safe_report(report: dict) -> dict:
    """An allowlist prevents task IDs, answers, labels or prose reaching another model."""
    result = {}
    for key in (
        "tasks",
        "accuracy",
        "known_cost_usd",
        "cost_usd",
        "unknown_cost_calls",
        "calls",
        "cache_hits",
        "known_input_tokens",
        "known_output_tokens",
        "p50_elapsed_ms",
        "p95_elapsed_ms",
        "usage_complete",
    ):
        value = report.get(key)
        if key == "usage_complete" and type(value) is bool:
            result[key] = value
        elif value is None:
            result[key] = value
        elif type(value) in (int, float) and math.isfinite(value) and value >= 0:
            result[key] = value
        else:
            raise ValueError("invalid_benchmark_metric")
    for key in ("dataset_sha256", "config_sha256"):
        value = report.get(key)
        if (
            isinstance(value, str)
            and len(value) == 64
            and all(c in "0123456789abcdef" for c in value)
        ):
            result[key] = value
    result["mode"] = report.get("mode") if report.get("mode") in {"openai", "mock"} else "unknown"
    result["benchmark_kind"] = "local_development_not_organizer_score"
    failed = {key: 0 for key in CHECKS}
    if "records" in report:
        for record in report["records"]:
            for key, passed in record.get("checks", {}).items():
                if key in failed and passed is False:
                    failed[key] += 1
    else:
        for key, count in report.get("failed_checks", {}).items():
            if key in failed and type(count) is int and count >= 0:
                failed[key] = count
    result["failed_checks"] = failed
    if type(result["tasks"]) is not int or result["tasks"] < 1:
        raise ValueError("invalid_benchmark_task_count")
    if type(result["accuracy"]) not in (int, float) or not 0 <= result["accuracy"] <= 1:
        raise ValueError("invalid_benchmark_accuracy")
    return result


def review(champion: dict, candidate: dict) -> tuple[bool, str]:
    for key in ("dataset_sha256", "tasks", "mode", "benchmark_kind"):
        if key not in champion or candidate.get(key) != champion[key]:
            return False, "incomparable_report"
    if any(
        report.get("cost_usd") is None
        or report.get("unknown_cost_calls", 0)
        or report.get("usage_complete") is not True
        for report in (champion, candidate)
    ):
        return False, "unknown_cost"
    accuracy_gain = candidate["accuracy"] - champion["accuracy"]
    cost_gain = champion["cost_usd"] - candidate["cost_usd"]
    if accuracy_gain < 0 or cost_gain < 0:
        return False, "tradeoff_rejected"
    if accuracy_gain == 0 and cost_gain == 0:
        return False, "no_strict_gain"
    return True, "pareto_improvement"


class CampaignStore:
    def __init__(self, tracker: Tracker):
        self.tracker = tracker
        with tracker._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS optimization_campaigns (
                    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    status TEXT NOT NULL, git_head TEXT NOT NULL, dev_digest TEXT NOT NULL,
                    budget_usd REAL NOT NULL, max_iterations INTEGER NOT NULL,
                    champion_config_json TEXT NOT NULL, champion_report_json TEXT NOT NULL,
                    spent_usd REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS optimization_trials (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL,
                    iteration INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL,
                    config_json TEXT NOT NULL, report_json TEXT NOT NULL,
                    decision_json TEXT NOT NULL,
                    FOREIGN KEY(campaign_id) REFERENCES optimization_campaigns(id)
                );
                CREATE INDEX IF NOT EXISTS optimization_trials_campaign
                    ON optimization_trials(campaign_id, id);
                CREATE TABLE IF NOT EXISTS optimization_holdouts (
                    digest TEXT PRIMARY KEY, claimed_at TEXT NOT NULL,
                    campaign_id TEXT NOT NULL REFERENCES optimization_campaigns(id)
                );
                INSERT OR IGNORE INTO optimization_holdouts (digest,claimed_at,campaign_id)
                    SELECT json_extract(report_json,'$.dataset_sha256'),created_at,campaign_id
                    FROM optimization_trials
                    WHERE (json_extract(decision_json,'$.phase')='holdout' OR status='holdout')
                    AND length(json_extract(report_json,'$.dataset_sha256'))=64
                    AND json_extract(report_json,'$.dataset_sha256') NOT GLOB '*[^0-9a-f]*';
            """)

    def claim_holdout(self, digest: str, campaign_id: str) -> bool:
        # The primary key makes the reservation atomic across simultaneous
        # campaigns. A failed or interrupted measurement never releases it.
        with self.tracker._db() as db:
            claimed = db.execute(
                "INSERT INTO optimization_holdouts (digest,claimed_at,campaign_id) VALUES (?,?,?) "
                "ON CONFLICT(digest) DO NOTHING",
                (digest, _now(), campaign_id),
            )
            return claimed.rowcount == 1

    def is_reserved_holdout(self, digest: str) -> bool:
        with self.tracker._db() as db:
            return (
                db.execute(
                    "SELECT 1 FROM optimization_holdouts WHERE digest=?", (digest,)
                ).fetchone()
                is not None
            )

    def previous(self, git_head: str, dev_digest: str, fixed_digest: str) -> dict | None:
        with self.tracker._db() as db:
            row = db.execute(
                "SELECT * FROM optimization_campaigns WHERE git_head=? AND dev_digest=? "
                "AND json_extract(champion_config_json,'$.fixed_config_sha256')=? "
                "AND champion_report_json!='{}' ORDER BY updated_at DESC LIMIT 1",
                (git_head, dev_digest, fixed_digest),
            ).fetchone()
        return dict(row) if row is not None else None

    def has_holdout(self, git_head: str, dev_digest: str, fixed_digest: str) -> bool:
        with self.tracker._db() as db:
            return (
                db.execute(
                    "SELECT 1 FROM optimization_trials t JOIN optimization_campaigns c "
                    "ON c.id=t.campaign_id WHERE c.git_head=? AND c.dev_digest=? "
                    "AND json_extract(c.champion_config_json,'$.fixed_config_sha256')=? "
                    "AND (json_extract(t.decision_json,'$.phase')='holdout' OR t.status='holdout') "
                    "LIMIT 1",
                    (git_head, dev_digest, fixed_digest),
                ).fetchone()
                is not None
            )

    def history(self, git_head: str, dev_digest: str, fixed_digest: str) -> list[dict]:
        with self.tracker._db() as db:
            rows = db.execute(
                "SELECT t.config_json,t.report_json,t.decision_json FROM optimization_trials t "
                "JOIN optimization_campaigns c ON c.id=t.campaign_id "
                "WHERE c.git_head=? AND c.dev_digest=? "
                "AND json_extract(c.champion_config_json,'$.fixed_config_sha256')=? "
                "AND t.iteration>0 AND t.status NOT IN ('running','baseline','holdout') "
                "AND coalesce(json_extract(t.decision_json,'$.phase'),'tuning')!='holdout' "
                "ORDER BY t.id DESC LIMIT 30",
                (git_head, dev_digest, fixed_digest),
            ).fetchall()
        return [
            {
                "configuration": json.loads(row["config_json"]),
                "decision": json.loads(row["decision_json"]),
                "measured": json.loads(row["report_json"]),
            }
            for row in reversed(rows)
        ]

    def candidate_seen(
        self, git_head: str, dev_digest: str, fixed_digest: str, candidate_digest: str
    ) -> bool:
        with self.tracker._db() as db:
            return (
                db.execute(
                    "SELECT 1 FROM optimization_trials t JOIN optimization_campaigns c "
                    "ON c.id=t.campaign_id WHERE c.git_head=? AND c.dev_digest=? "
                    "AND json_extract(c.champion_config_json,'$.fixed_config_sha256')=? "
                    "AND json_extract(t.config_json,'$.candidate_sha256')=? LIMIT 1",
                    (git_head, dev_digest, fixed_digest, candidate_digest),
                ).fetchone()
                is not None
            )

    def create(
        self, git_head: str, dev_digest: str, budget: float, iterations: int, config: Config
    ):
        campaign_id = str(uuid.uuid4())
        now = _now()
        with self.tracker._db() as db:
            db.execute(
                "INSERT INTO optimization_campaigns VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    campaign_id,
                    now,
                    now,
                    "running",
                    git_head,
                    dev_digest,
                    budget,
                    iterations,
                    _json(safe_config(config)),
                    "{}",
                    0.0,
                ),
            )
        return campaign_id

    def update(self, campaign_id: str, config: Config, report: dict, status: str, spent: float):
        with self.tracker._db() as db:
            db.execute(
                "UPDATE optimization_campaigns SET updated_at=?,status=?,champion_config_json=?,"
                "champion_report_json=?,spent_usd=? WHERE id=?",
                (_now(), status, _json(safe_config(config)), _json(report), spent, campaign_id),
            )

    def trial(
        self, campaign_id: str, iteration: int, config: Config, *, phase: str = "tuning"
    ) -> int:
        with self.tracker._db() as db:
            cursor = db.execute(
                "INSERT INTO optimization_trials (campaign_id,iteration,created_at,status,"
                "config_json,report_json,decision_json) VALUES (?,?,?,?,?,?,?)",
                (
                    campaign_id,
                    iteration,
                    _now(),
                    "running",
                    _json(safe_config(config)),
                    "{}",
                    _json({"phase": phase}),
                ),
            )
            return cursor.lastrowid

    def finish_trial(self, trial: int, config: Config, report: dict, status: str, decision: dict):
        with self.tracker._db() as db:
            previous = db.execute(
                "SELECT decision_json FROM optimization_trials WHERE id=?", (trial,)
            ).fetchone()
            merged = json.loads(previous["decision_json"])
            merged.update(decision)
            db.execute(
                "UPDATE optimization_trials SET status=?,config_json=?,report_json=?,"
                "decision_json=? WHERE id=?",
                (status, _json(safe_config(config)), _json(report), _json(merged), trial),
            )

    def plan_trial(self, trial: int, config: Config, edit: ConfigEdit) -> None:
        """Commit the validated plan before a measurement can perform effects."""
        with self.tracker._db() as db:
            previous = db.execute(
                "SELECT decision_json FROM optimization_trials WHERE id=? AND status='running'",
                (trial,),
            ).fetchone()
            if previous is None:
                raise ValueError("trial_not_running")
            decision = json.loads(previous["decision_json"])
            decision.update(edit.model_dump(), accepted=False)
            db.execute(
                "UPDATE optimization_trials SET config_json=?,decision_json=? "
                "WHERE id=? AND status='running'",
                (_json(safe_config(config)), _json(decision), trial),
            )


class ModelProposer:
    def __init__(self, tracker: Tracker, git_head: str):
        self.tracker, self.git_head = tracker, git_head

    def __call__(
        self, config: Config, report: dict, recent: list[dict], remaining: float
    ) -> ConfigEdit:
        if config.model.provider != "openai":
            raise ValueError("optimizer_requires_configured_model")
        limits = config.limits.model_copy(
            update={
                "max_output_tokens": min(400, config.limits.max_output_tokens),
                "task_timeout_seconds": min(remaining, config.limits.task_timeout_seconds),
            }
        )
        run_id = self.tracker.start_run(
            "optimizer-analyst",
            config.model_dump(),
            mode=config.model.provider,
            metadata={"git_head": self.git_head},
        )
        provider = None
        status = "error"
        try:
            provider = SmallModelProvider(
                config.model,
                limits,
                Budget(limits),
                self.tracker,
                run_id,
                spend=DevSpend(config.budget, self.tracker),
            )
            with provider_stage("optimizer_analyst"):
                reply = provider.complete(
                    [
                        {
                            "role": "system",
                            "content": (
                                "Propose ONE allowed configuration edit for a cheaper, accurate "
                                "agent. Only measured development aggregates are provided. "
                                "Never invent results. A deterministic reviewer will accept only "
                                "measured Pareto improvements. "
                                "Return only JSON with field, value, hypothesis; no prose. "
                                "Allowed fields/domains: "
                                + _json(FIELDS)
                                + ". Hypothesis must be one of "
                                "batch_queries, reduce_context, preload_evidence, "
                                "adjust_inventory, reduce_copying. Do not propose the current "
                                "value or repeat rejected edits."
                            ),
                        },
                        {
                            "role": "user",
                            "content": _json(
                                {
                                    "configuration": safe_config(config),
                                    "measured": safe_report(report),
                                    "previous_trials": recent[-10:],
                                }
                            ),
                        },
                    ],
                    ConfigEdit.model_json_schema(),
                )
            edit = ConfigEdit.model_validate(reply)
            status = "ok"
            return edit
        finally:
            if provider is not None:
                provider.close()
            self.tracker.finish_run(run_id, status)


def _clamp_budget(config: Config, ceiling: float) -> Config:
    values = config.model_dump()
    existing = config.budget.max_usd
    values["budget"]["max_usd"] = min(existing, ceiling) if existing is not None else ceiling
    values["cache"]["mode"] = "off"
    return Config.model_validate(values)


def run_campaign(
    config: Config,
    tracker: Tracker,
    runner: Callable[[Config, float], dict],
    proposer: Callable[[Config, dict, list[dict], float], ConfigEdit],
    *,
    git_head: str,
    dev_digest: str,
    max_iterations: int = 3,
    max_usd: float = 0.05,
    max_seconds: float = 600,
    clock: Callable[[], float] = time.monotonic,
    holdout_runner: Callable[[Config, float], dict] | None = None,
    holdout_digest: Callable[[], str] | None = None,
    finalize: bool = False,
    on_start: Callable[[dict], None] | None = None,
) -> dict:
    """Testable finite loop. Runner/proposer perform effects; review owns promotion.

    A new invocation reuses a matching champion's configuration and measures
    a fresh development baseline. Finalization freezes before any hold-out
    access. New spending caps never reset the shared development allowance.
    """
    if (
        not 0 <= max_iterations <= 100
        or not 0 < max_usd <= 100
        or not math.isfinite(max_seconds)
        or max_seconds <= 0
    ):
        raise ValueError("invalid_campaign_limits")
    started = clock()
    initial_spend = tracker.spend()
    config = _clamp_budget(config, initial_spend["usd"] + max_usd)
    store = CampaignStore(tracker)
    reserved_development = store.is_reserved_holdout(dev_digest)
    fixed_digest = safe_config(config)["fixed_config_sha256"]
    previous = store.previous(git_head, dev_digest, fixed_digest)
    frozen = store.has_holdout(git_head, dev_digest, fixed_digest)
    report: dict = {}
    if previous:
        config = restore_config(config, json.loads(previous["champion_config_json"]))
        if finalize or frozen:
            report = json.loads(previous["champion_report_json"])
    campaign_id = store.create(git_head, dev_digest, max_usd, max_iterations, config)
    recent = store.history(git_head, dev_digest, fixed_digest)
    seen = {
        item["configuration"]["candidate_sha256"]
        for item in recent
        if "candidate_sha256" in item["configuration"]
    }
    seen.add(safe_config(config)["candidate_sha256"])
    status = "running"

    def remaining() -> float:
        return max_seconds - (clock() - started)

    def spent() -> float:
        return max(0.0, tracker.spend()["usd"] - initial_spend["usd"])

    def stop_reason() -> str | None:
        if getattr(tracker, "receipts_complete", True) is not True:
            return "unknown_cost"
        current = tracker.spend()
        if current["unknown_cost_calls"] > initial_spend["unknown_cost_calls"]:
            return "unknown_cost"
        if remaining() <= 0:
            return "timed_out"
        if spent() >= max_usd:
            return "budget_exhausted"
        if config.budget.max_usd is not None and current["usd"] >= config.budget.max_usd:
            return "budget_exhausted"
        if config.budget.max_calls is not None and current["calls"] >= config.budget.max_calls:
            return "budget_exhausted"
        if config.budget.max_tokens is not None and current["tokens"] >= config.budget.max_tokens:
            return "budget_exhausted"
        return None

    def measure(candidate: Config, remaining_seconds: float, run: Callable) -> dict:
        if getattr(tracker, "receipts_complete", True) is not True:
            raise MeasurementUncertain("optimization_receipts_incomplete", timed_out=False)
        raw_report = run(candidate, remaining_seconds)
        if getattr(tracker, "receipts_complete", True) is not True:
            raise MeasurementUncertain("optimization_receipts_incomplete", timed_out=False)
        measured = safe_report(raw_report)
        if measured.get("dataset_sha256") != dev_digest and run is runner:
            raise ValueError("development_digest_changed")
        if run is holdout_runner and measured.get("dataset_sha256") == dev_digest:
            raise HoldoutNotDistinct("holdout_matches_development")
        return measured

    def cost_unknown(measured: dict) -> bool:
        return (
            measured.get("cost_usd") is None
            or bool(measured.get("unknown_cost_calls"))
            or measured.get("usage_complete") is not True
        )

    try:
        if on_start is not None:
            # The private parent channel establishes ownership before effects.
            # It contains no task data, answers, provider bodies or credentials.
            on_start(
                {
                    "id": campaign_id,
                    "status": "running",
                    "git_head": git_head,
                    "starting_known_usd": initial_spend["usd"],
                }
            )
        if reserved_development:
            status = "development_is_reserved_holdout"
            trial = store.trial(campaign_id, 0, config, phase="baseline")
            store.finish_trial(trial, config, {}, "rejected", {"reason": status})
        elif frozen:
            status = "already_finalized"
        elif finalize and not previous:
            status = "no_champion_to_finalize"
        elif stop_reason():
            status = stop_reason() or "budget_exhausted"
        elif not report:
            trial = store.trial(campaign_id, 0, config, phase="baseline")
            try:
                report = measure(config, remaining(), runner)
            except MeasurementUncertain as exc:
                store.finish_trial(
                    trial,
                    config,
                    {"cost_usd": None, "usage_complete": False},
                    "timed_out" if exc.timed_out else "error",
                    {
                        "reason": "measurement_timed_out"
                        if exc.timed_out
                        else "measurement_incomplete",
                        "unobserved_external_attempt_possible": True,
                    },
                )
                raise
            except TimeoutError:
                store.finish_trial(
                    trial, config, {}, "timed_out", {"reason": "measurement_timed_out"}
                )
                raise
            except Exception:
                store.finish_trial(trial, config, {}, "error", {"reason": "baseline_failed"})
                raise
            except BaseException:
                store.finish_trial(
                    trial,
                    config,
                    {"cost_usd": None, "usage_complete": False},
                    "error",
                    {
                        "reason": "campaign_interrupted",
                        "unobserved_external_attempt_possible": True,
                    },
                )
                raise
            store.finish_trial(trial, config, report, "baseline", {"reason": "measured_baseline"})
            if cost_unknown(report):
                status = "unknown_cost"
        else:
            trial = store.trial(campaign_id, 0, config, phase="baseline")
            store.finish_trial(trial, config, report, "baseline", {"reason": "resumed_champion"})
        if status == "running" and report and cost_unknown(report):
            status = "unknown_cost"
        if status == "running" and not finalize:
            for iteration in range(1, max_iterations + 1):
                reason = stop_reason()
                if reason:
                    status = reason
                    break
                trial = store.trial(campaign_id, iteration, config)
                candidate = config
                measured: dict = {}
                decision: dict = {"accepted": False}
                trial_status = "error"
                try:
                    edit = ConfigEdit.model_validate(proposer(config, report, recent, remaining()))
                    decision.update(edit.model_dump())
                    section, key = edit.field.split(".")
                    current_value = config.model_dump()[section][key]
                    candidate = apply_edit(config, edit) if current_value != edit.value else config
                    candidate_digest = safe_config(candidate)["candidate_sha256"]
                    if candidate_digest in seen or store.candidate_seen(
                        git_head, dev_digest, fixed_digest, candidate_digest
                    ):
                        decision["reason"] = "duplicate_candidate"
                        trial_status = "rejected"
                        continue
                    store.plan_trial(trial, candidate, edit)
                    seen.add(candidate_digest)
                    reason = stop_reason()
                    if reason:
                        status = reason
                        decision["reason"] = reason
                    else:
                        measured = measure(candidate, remaining(), runner)
                        accepted, reason = review(report, measured)
                        decision.update(accepted=accepted, reason=reason)
                        trial_status = "accepted" if accepted else "rejected"
                        if cost_unknown(measured):
                            status = "unknown_cost"
                        if accepted:
                            config, report = candidate, measured
                except MeasurementUncertain as exc:
                    status, trial_status = "unknown_cost", "timed_out" if exc.timed_out else "error"
                    measured = {"cost_usd": None, "usage_complete": False}
                    decision.update(
                        reason="measurement_timed_out"
                        if exc.timed_out
                        else "measurement_incomplete",
                        unobserved_external_attempt_possible=True,
                    )
                except TimeoutError:
                    status, trial_status = "timed_out", "timed_out"
                    decision["reason"] = "measurement_timed_out"
                except (ValueError, ValidationError):
                    decision["reason"] = "proposal_or_measurement_invalid"
                except Exception:
                    decision["reason"] = "proposal_or_measurement_failed"
                except BaseException:
                    status = "unknown_cost"
                    measured = {"cost_usd": None, "usage_complete": False}
                    decision.update(
                        reason="campaign_interrupted", unobserved_external_attempt_possible=True
                    )
                    raise
                finally:
                    if getattr(tracker, "receipts_complete", True) is not True:
                        status, trial_status = "unknown_cost", "error"
                        measured = {"cost_usd": None, "usage_complete": False}
                        decision.update(
                            accepted=False,
                            reason="receipts_incomplete",
                            unobserved_external_attempt_possible=True,
                        )
                    store.finish_trial(trial, candidate, measured, trial_status, decision)
                    recent.append(
                        {
                            "configuration": safe_config(candidate),
                            "decision": decision,
                            "measured": measured,
                        }
                    )
                    recent = recent[-30:]
                    store.update(campaign_id, config, report, status, spent())
                if status != "running":
                    break
            if status == "running":
                status = stop_reason() or "completed"
        if status == "running" and finalize:
            reason = stop_reason()
            if reason:
                status = reason
            elif holdout_runner is None:
                status = "holdout_not_configured"
            else:
                # Freeze first: hold-out observations never enter a proposal or
                # promotion decision, and no subsequent tuning follows this call.
                trial = store.trial(campaign_id, max_iterations + 1, config, phase="holdout")
                try:
                    # The durable hold-out phase above is the freeze. Even an
                    # unreadable file, failed request or killed child cannot
                    # reopen this context for tuning on a later invocation.
                    if holdout_digest is None:
                        raise ValueError("holdout_identity_required")
                    expected_holdout = holdout_digest()
                    if (
                        not isinstance(expected_holdout, str)
                        or len(expected_holdout) != 64
                        or any(
                            character not in "0123456789abcdef" for character in expected_holdout
                        )
                    ):
                        raise ValueError("holdout_identity_invalid")
                    if expected_holdout == dev_digest:
                        raise HoldoutNotDistinct("holdout_matches_development")
                    if not store.claim_holdout(expected_holdout, campaign_id):
                        raise HoldoutAlreadyUsed("holdout_already_used")
                    held_out = measure(config, remaining(), holdout_runner)
                    if (
                        expected_holdout is not None
                        and held_out.get("dataset_sha256") != expected_holdout
                    ):
                        raise ValueError("holdout_digest_changed")
                    store.finish_trial(
                        trial, config, held_out, "holdout", {"reason": "frozen_holdout"}
                    )
                    status = "unknown_cost" if cost_unknown(held_out) else "finalized"
                except HoldoutAlreadyUsed:
                    store.finish_trial(
                        trial, config, {}, "rejected", {"reason": "holdout_already_used"}
                    )
                    raise
                except HoldoutNotDistinct:
                    store.finish_trial(
                        trial, config, {}, "error", {"reason": "holdout_not_distinct"}
                    )
                    raise
                except MeasurementUncertain as exc:
                    store.finish_trial(
                        trial,
                        config,
                        {"cost_usd": None, "usage_complete": False},
                        "timed_out" if exc.timed_out else "error",
                        {
                            "reason": "measurement_timed_out"
                            if exc.timed_out
                            else "measurement_incomplete",
                            "unobserved_external_attempt_possible": True,
                        },
                    )
                    raise
                except Exception:
                    store.finish_trial(trial, config, {}, "error", {"reason": "holdout_failed"})
                    raise
                except BaseException:
                    store.finish_trial(
                        trial,
                        config,
                        {"cost_usd": None, "usage_complete": False},
                        "error",
                        {
                            "reason": "campaign_interrupted",
                            "unobserved_external_attempt_possible": True,
                        },
                    )
                    raise
    except HoldoutAlreadyUsed:
        status = "holdout_already_used"
    except MeasurementUncertain:
        status = "unknown_cost"
    except TimeoutError:
        status = "timed_out"
    except Exception:
        status = stop_reason() or "error"
    except BaseException:
        status = "unknown_cost"
        raise
    finally:
        store.update(campaign_id, config, report, status, spent())
    return {
        "id": campaign_id,
        "status": status,
        "git_head": git_head,
        "dev_digest": dev_digest,
        "champion_config": safe_config(config),
        "champion_report": report,
        "spent_usd": spent(),
        "budget_usd": max_usd,
        "max_iterations": max_iterations,
        "spend_complete": status != "unknown_cost",
        "note": "Configured-price estimates and a soft development cap, not an invoice guarantee.",
    }


def _private_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ValueError("private_json_symlink_refused")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, allow_nan=False)
            stream.write("\n")
        # A killed writer leaves the previous complete checkpoint available.
        # Replacing a concurrently introduced symlink replaces only the link.
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _recover_worker_campaign(database: Path, output: Path, expected_head: str) -> dict | None:
    """Reconcile only this stopped worker's private running checkpoint.

    A terminal output or campaign always wins. Interrupted measurements are
    uncertain records, never evidence for inventing a provider request.
    """
    try:
        checkpoint = json.loads(output.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(checkpoint, dict):
        return None
    campaign_id = checkpoint.get("id")
    starting = checkpoint.get("starting_known_usd")
    if (
        checkpoint.get("status") != "running"
        or checkpoint.get("git_head") != expected_head
        or not isinstance(campaign_id, str)
        or type(starting) not in (int, float)
        or not math.isfinite(starting)
        or starting < 0
        or not database.is_file()
    ):
        return None
    try:
        if str(uuid.UUID(campaign_id)) != campaign_id:
            return None
    except ValueError:
        return None
    tracker = Tracker(database)
    with tracker._db() as db:
        # The worker has stopped. Serialize the ownership/status check with
        # updates so a terminal result cannot be overwritten between them.
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM optimization_campaigns WHERE id=? AND git_head=? AND status='running'",
            (campaign_id, expected_head),
        ).fetchone()
        if row is None:
            return None
        spent = max(0.0, tracker.spend()["usd"] - starting)
        pending = db.execute(
            "SELECT id,decision_json FROM optimization_trials "
            "WHERE campaign_id=? AND status='running'",
            (campaign_id,),
        ).fetchall()
        for trial in pending:
            decision = json.loads(trial["decision_json"])
            decision.update(
                accepted=False,
                reason="worker_interrupted",
                unobserved_external_attempt_possible=True,
            )
            db.execute(
                "UPDATE optimization_trials SET status='error',report_json=?,decision_json=? "
                "WHERE id=? AND campaign_id=? AND status='running'",
                (
                    _json({"cost_usd": None, "usage_complete": False}),
                    _json(decision),
                    trial["id"],
                    campaign_id,
                ),
            )
        db.execute(
            "UPDATE optimization_campaigns SET updated_at=?,status='unknown_cost',spent_usd=? "
            "WHERE id=? AND git_head=? AND status='running'",
            (_now(), spent, campaign_id, expected_head),
        )
        recovered = {
            "id": campaign_id,
            "status": "unknown_cost",
            "git_head": expected_head,
            "dev_digest": row["dev_digest"],
            "champion_config": json.loads(row["champion_config_json"]),
            "champion_report": json.loads(row["champion_report_json"]),
            "spent_usd": spent,
            "budget_usd": row["budget_usd"],
            "max_iterations": row["max_iterations"],
            "spend_complete": False,
            "reason": "worker_interrupted",
        }
    _private_json(output, recovered)
    return recovered


_OWNED_PROCESSES: dict[subprocess.Popen, float] = {}


def _stop_owned(process: subprocess.Popen) -> None:
    """Terminate only a process group created and registered by this module."""
    if process not in _OWNED_PROCESSES:
        return
    grace = _OWNED_PROCESSES.pop(process)
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait(timeout=2)
        return
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # A wrapper may exit before a stubborn grandchild. The group still
        # belongs to this invocation, so finish its cleanup as well.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=2)


def _cleanup_owned() -> None:
    for process in list(_OWNED_PROCESSES):
        _stop_owned(process)


def _interrupted(signum, frame) -> None:
    # A second interrupt must not reenter cleanup or abort the receipt
    # finalization that runs while this first SystemExit unwinds.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    _cleanup_owned()
    raise SystemExit(128 + signum)


def _command(
    argv: list[str], cwd: Path, env: dict[str, str], timeout: float, *, shutdown_grace: float = 2
) -> None:
    """Bound the owned process group, including uv's child, without logging bodies."""
    if timeout <= 0:
        raise TimeoutError("campaign_timed_out")
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    _OWNED_PROCESSES[process] = shutdown_grace
    try:
        return_code = process.wait(timeout=timeout)
        if return_code:
            raise RuntimeError("owned_child_failed")
    except subprocess.TimeoutExpired:
        raise TimeoutError("owned_measurement_timed_out") from None
    finally:
        # Also runs for KeyboardInterrupt, SystemExit and other BaseExceptions.
        # On a parent TERM the worker's handler cleans its separately registered
        # measurement groups before the parent's grace period ends.
        _stop_owned(process)


def _git(repo: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *arguments],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result.stdout.strip()


def _measure(args, config: Config, tracker: Tracker) -> None:
    """Private child entry: safe tuning state plus the committed base config."""
    tuning = json.loads(args._tuning.read_text())
    config = restore_config(config, tuning["configuration"])
    config = _clamp_budget(config, tuning["budget_ceiling"])
    if _digest(config.model_dump()) != tuning["runtime_config_sha256"]:
        raise ValueError("runtime_configuration_mismatch")
    if not tracker.receipts_complete:
        raise RuntimeError("optimization_receipts_incomplete")
    input_digest = dataset_digest(args.dataset, args.root, load_cases(args.dataset))
    report = benchmark(args.dataset, args.root, config, tracker, repeat=args.repeat)
    if not tracker.receipts_complete:
        raise RuntimeError("optimization_receipts_incomplete")
    if (
        report.get("dataset_sha256") != input_digest
        or dataset_digest(args.dataset, args.root, load_cases(args.dataset)) != input_digest
    ):
        raise RuntimeError("measurement_inputs_changed")
    _private_json(args._out, report)


def _worker(args, config: Config, tracker: Tracker, git_head: str) -> dict:
    cases = load_cases(args.dataset)
    dev_digest = dataset_digest(args.dataset, args.root, cases)
    initial_unknown = tracker.spend()["unknown_cost_calls"]
    os.environ["HACKLAB_OPTIMIZATION_UNKNOWN_BASELINE"] = str(initial_unknown)
    if deadline := os.environ.get("HACKLAB_OPTIMIZATION_DEADLINE"):
        args.max_seconds = min(args.max_seconds, float(deadline) - time.monotonic() - 5)
    state = args.state / str(uuid.uuid4())
    state.mkdir(parents=True, mode=0o700)
    counter = 0

    def runner_for(dataset: Path, documents: Path):
        def run(candidate: Config, remaining: float) -> dict:
            nonlocal counter
            counter += 1
            tuning_path, output = state / f"tuning-{counter}.json", state / f"report-{counter}.json"
            _private_json(
                tuning_path,
                {
                    "configuration": safe_config(candidate),
                    "budget_ceiling": candidate.budget.max_usd,
                    "runtime_config_sha256": _digest(candidate.model_dump()),
                    "git_head": git_head,
                },
            )
            argv = [
                "uv",
                "run",
                "--locked",
                "python",
                "-m",
                "hacklab.optimize",
                "--_measure",
                "--config",
                str(args.config),
                "--dataset",
                str(dataset),
                "--root",
                str(documents),
                "--db",
                str(args.db),
                "--env-file",
                str(args.env_file),
                "--_tuning",
                str(tuning_path),
                "--_out",
                str(output),
                "--repeat",
                str(args.repeat),
            ]
            try:
                _command(argv, Path.cwd(), dict(os.environ), remaining)
            except TimeoutError:
                # Do not invent a provider receipt or inflate request counts.
                # The trial records this uncertainty and stops the campaign.
                raise MeasurementUncertain("unobserved_external_attempt_possible") from None
            except (RuntimeError, subprocess.SubprocessError):
                # A nonzero exit may follow an HTTP request whose receipt was
                # never written (for example after SIGKILL or an OOM).
                raise MeasurementUncertain(
                    "unobserved_external_attempt_possible", timed_out=False
                ) from None
            try:
                measured = json.loads(output.read_text())
                if not isinstance(measured, dict):
                    raise ValueError("measurement_output_must_be_object")
            except (OSError, ValueError):
                # The measurement child ran, but its missing/unreadable output
                # cannot establish whether every external attempt was observed.
                raise MeasurementUncertain(
                    "unobserved_external_attempt_possible", timed_out=False
                ) from None
            return measured

        return run

    runner = runner_for(args.dataset, args.root)
    # Constructing the closure does not open or inspect hold-out data. Only
    # the frozen finalization branch can invoke it.
    holdout = (
        runner_for(args.holdout_dataset, args.holdout_root)
        if args.finalize and args.holdout_dataset and args.holdout_root
        else None
    )

    def holdout_identity() -> str:
        return dataset_digest(
            args.holdout_dataset, args.holdout_root, load_cases(args.holdout_dataset)
        )

    return run_campaign(
        config,
        tracker,
        runner,
        ModelProposer(tracker, git_head),
        git_head=git_head,
        dev_digest=dev_digest,
        max_iterations=args.iterations,
        max_usd=args.max_usd,
        max_seconds=args.max_seconds,
        holdout_runner=holdout,
        holdout_digest=holdout_identity if holdout is not None else None,
        finalize=args.finalize,
        on_start=lambda checkpoint: _private_json(args._out, checkpoint),
    )


def parser() -> argparse.ArgumentParser:
    app = argparse.ArgumentParser(description=__doc__)
    app.add_argument("--dataset", type=Path, required=True)
    app.add_argument("--root", type=Path, required=True)
    app.add_argument("--config", type=Path, required=True)
    app.add_argument(
        "--db", type=Path, default=Path(os.environ.get("HACKLAB_DB", ".state/tracking.sqlite"))
    )
    app.add_argument("--state", type=Path, default=Path(".state/optimization"))
    app.add_argument("--env-file", type=Path, default=Path(".env"))
    app.add_argument("--iterations", type=int, default=3)
    app.add_argument("--repeat", type=int, default=2)
    app.add_argument("--max-usd", type=float, default=0.05)
    app.add_argument("--max-seconds", type=float, default=600)
    app.add_argument("--holdout-dataset", type=Path)
    app.add_argument("--holdout-root", type=Path)
    app.add_argument("--finalize", action="store_true")
    app.add_argument("--_worker", action="store_true", help=argparse.SUPPRESS)
    app.add_argument("--_measure", action="store_true", help=argparse.SUPPRESS)
    app.add_argument("--_tuning", type=Path, help=argparse.SUPPRESS)
    app.add_argument("--_out", type=Path, help=argparse.SUPPRESS)
    return app


def main(argv=None) -> int:
    started = time.monotonic()
    args = parser().parse_args(argv)
    if not callable(getattr(os, "killpg", None)):
        print('{"status":"error","reason":"unsupported_platform"}')
        return 1
    for key in (
        "dataset",
        "root",
        "config",
        "db",
        "state",
        "env_file",
        "holdout_dataset",
        "holdout_root",
    ):
        value = getattr(args, key)
        if value is not None:
            setattr(args, key, value.expanduser().absolute())
    previous_handlers = {
        number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)
    }
    for number in previous_handlers:
        signal.signal(number, _interrupted)
    try:
        if (
            not 0 <= args.iterations <= 100
            or not 1 <= args.repeat <= 10
            or not 0 < args.max_usd <= 100
            or not math.isfinite(args.max_seconds)
            or args.max_seconds <= 0
        ):
            raise ValueError("invalid_campaign_limits")
        if args._worker or args._measure:
            if _git(Path.cwd(), "rev-parse", "--abbrev-ref", "HEAD") != "HEAD":
                raise ValueError("optimizer_requires_detached_worktree")
            load_dotenv(args.env_file)
            os.environ["HACKLAB_CACHE_MODE"] = "off"
            os.environ.pop("HACKLAB_TRACE_DIR", None)
            config = load_config(args.config)
            tracker = Tracker(args.db)
            if args._measure:
                _measure(args, config, tracker)
            else:
                result = _worker(args, config, tracker, _git(Path.cwd(), "rev-parse", "HEAD"))
                _private_json(args._out, result)
            return 0
        # Only committed source/config enter the disposable experiment. Data,
        # database and normal dotenv authentication remain explicit inputs.
        checkout = Path(_git(Path.cwd(), "rev-parse", "--show-toplevel"))
        git_head = _git(checkout, "rev-parse", "HEAD")
        config_relative = args.config.resolve().relative_to(checkout)
        _git(checkout, "cat-file", "-e", f"{git_head}:{config_relative.as_posix()}")
        args.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        output = args.state / f"campaign-{uuid.uuid4()}.json"
        env = dict(os.environ)
        env["HACKLAB_DB"] = str(args.db)
        env["HACKLAB_CACHE_MODE"] = "off"
        env["HACKLAB_OPTIMIZATION_DEADLINE"] = str(started + args.max_seconds)
        env.pop("HACKLAB_TRACE_DIR", None)
        for name in ("PYTHONPATH", "PYTHONHOME", "UV_PROJECT_ENVIRONMENT", "VIRTUAL_ENV"):
            env.pop(name, None)
        with tempfile.TemporaryDirectory(prefix="hacklab-optimize-") as temporary:
            worktree = Path(temporary) / "worktree"
            _git(checkout, "worktree", "add", "--detach", str(worktree), git_head)
            try:
                # Run the owning fast gate once on the committed source, before
                # any proposal or benchmark can make a model request.
                remaining = args.max_seconds - (time.monotonic() - started)
                _command(["bash", "scripts/check"], worktree, env, min(300, remaining))
                remaining = args.max_seconds - (time.monotonic() - started)
                command = [
                    "uv",
                    "run",
                    "--locked",
                    "python",
                    "-m",
                    "hacklab.optimize",
                    "--_worker",
                    "--dataset",
                    str(args.dataset),
                    "--root",
                    str(args.root),
                    "--config",
                    str(worktree / config_relative),
                    "--db",
                    str(args.db),
                    "--state",
                    str(args.state),
                    "--env-file",
                    str(args.env_file),
                    "--iterations",
                    str(args.iterations),
                    "--repeat",
                    str(args.repeat),
                    "--max-usd",
                    str(args.max_usd),
                    "--max-seconds",
                    str(remaining),
                    "--_out",
                    str(output),
                ]
                if args.finalize:
                    command.append("--finalize")
                    if args.holdout_dataset and args.holdout_root:
                        command += [
                            "--holdout-dataset",
                            str(args.holdout_dataset),
                            "--holdout-root",
                            str(args.holdout_root),
                        ]
                _command(command, worktree, env, remaining, shutdown_grace=5)
            finally:
                try:
                    # _command stops its registered worker group before this
                    # finally runs, including on timeout, signal or nonzero exit.
                    _recover_worker_campaign(args.db, output, git_head)
                finally:
                    _git(checkout, "worktree", "remove", "--force", str(worktree))
        print(json.dumps(json.loads(output.read_text()), indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        print('{"status":"error","reason":"optimizer_setup_or_child_failed"}')
        return 1
    finally:
        _cleanup_owned()
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    raise SystemExit(main())
