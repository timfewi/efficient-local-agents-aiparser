"""Private local experiment receipts, without prompts, document text or credentials.

Costs are estimates from configured prices and provider-reported usage. Missing
usage or prices stay unknown; an HTTP failure is not proof that no charge arose.
"""

import hashlib
import json
import math
import os
import re
import sqlite3
import stat
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

_LABEL = re.compile(r"[A-Za-z0-9_.:/+@ -]{1,200}\Z")
_DIGEST = re.compile(r"[A-Fa-f0-9]{7,128}\Z")
_VERSION = re.compile(r"[A-Za-z0-9_.+~-]{1,100}\Z")
_NUMBER_KEYS = {
    "step",
    "attempt",
    "count",
    "score",
    "latency_ms",
    "elapsed_ms",
    "retry_after_seconds",
    "http_status",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "max_steps",
    "max_calls",
    "repaired",
    "citation_count",
    "cached_tokens",
    "reasoning_tokens",
}
_BOOL_KEYS = {"cache_hit", "cached", "usage_complete", "truncated", "verified", "dirty"}
_LABEL_KEYS = {
    "status",
    "action",
    "tool",
    "error_type",
    "reason_code",
    "provider",
    "model",
    "stage",
}


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _digest(value: Any) -> str:
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _label(value: Any, fallback: str = "redacted") -> str:
    return value if isinstance(value, str) and _LABEL.fullmatch(value) else fallback


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _cache_hit(row: Any) -> bool:
    """Whether a call row, stored or already decoded, was replayed from the cache."""
    keys = row.keys()
    metadata = row["metadata"] if "metadata" in keys else json.loads(row["metadata_json"])
    return bool(metadata.get("cache_hit"))


def _safe_event(data: dict) -> dict:
    """An allowlist prevents credentials hidden under arbitrary nested keys."""
    safe = {}
    for key, value in data.items():
        if key in _NUMBER_KEYS and type(value) in (int, float) and math.isfinite(value):
            safe[key] = value
        elif key in _BOOL_KEYS and type(value) is bool:
            safe[key] = value
        elif key in _LABEL_KEYS:
            safe[key] = _label(value)
    return safe


def _safe_metadata(data: dict | None) -> dict:
    safe = {}
    for key, value in (data or {}).items():
        if key in {
            "git_commit",
            "git_head",
            "suite_hash",
            "dataset_hash",
            "task_hash",
            "source_sha256",
        }:
            if isinstance(value, str) and _DIGEST.fullmatch(value):
                safe[key] = value
        elif key in {"git_dirty", "dirty"} and type(value) is bool:
            safe[key] = value
        elif key in {
            "python_version",
            "python",
            "hacklab_version",
            "httpx_version",
            "pydantic_version",
            "platform",
            "suite",
        }:
            if isinstance(value, str) and _LABEL.fullmatch(value):
                safe[key] = value
        elif key in {"versions", "dependencies"} and isinstance(value, dict):
            safe[key] = {
                name: version
                for name, version in value.items()
                if isinstance(name, str)
                and _VERSION.fullmatch(name)
                and isinstance(version, str)
                and _VERSION.fullmatch(version)
            }
    return safe


def _safe_config(config: dict) -> dict:
    safe = {}
    for section in ("model", "jev"):
        values = config.get(section, {})
        if not isinstance(values, dict):
            continue
        output = {}
        for key in ("provider", "model", "response_format", "api_key_env"):
            if key in values:
                output[key] = _label(values[key])
        for key in ("enabled", "select"):
            if type(values.get(key)) is bool:
                output[key] = values[key]
        for key in (
            "input_usd_per_million",
            "output_usd_per_million",
            "threshold",
            "select_threshold",
            "temperature",
        ):
            if values.get(key) is None:
                output[key] = None
            elif type(values[key]) in (int, float) and math.isfinite(values[key]):
                output[key] = values[key]
        if isinstance(values.get("base_url"), str):
            # Preserve the origin only: credentials can occur in path/query/fragment.
            try:
                parts = urlsplit(values["base_url"])
                if parts.hostname and parts.scheme in {"http", "https"}:
                    host = parts.hostname
                    if ":" in host:
                        host = f"[{host}]"
                    if parts.port:
                        host += f":{parts.port}"
                    output["origin"] = urlunsplit((parts.scheme, host, "", "", ""))
            except ValueError:
                pass
        safe[section] = output
    selections = {
        "agent": {
            "workflow",
            "pipeline_rounds",
            "list_preview",
            "preload_results",
            "decimal_separator",
            "inventory",
            "preload_documents_under",
            "thought_chars",
            "on_unverified",
            "playbooks",
            "skills",
            "tools",
        },
        "guard": {
            "injection",
            "compact_secrets",
            "decode_previews",
            "require_grounded_targets",
            "max_actions",
        },
        "cache": {"mode"},
    }
    for section, allowed in selections.items():
        values = config.get(section, {})
        if not isinstance(values, dict):
            continue
        safe[section] = {}
        for key, value in values.items():
            if key not in allowed:
                continue
            if type(value) in (int, bool):
                safe[section][key] = value
            elif isinstance(value, str):
                safe[section][key] = _label(value)
            elif isinstance(value, list):
                safe[section][key] = [_label(item) for item in value[:20]]
    limits = config.get("limits", {})
    allowed_limits = {
        "max_steps",
        "max_calls",
        "max_retries",
        "http_retries",
        "timeout_seconds",
        "task_timeout_seconds",
        "max_context_chars",
        "max_observation_chars",
        "max_output_tokens",
        "max_total_tokens",
        "max_cost_usd",
    }
    if isinstance(limits, dict):
        safe["limits"] = {
            key: value
            for key, value in limits.items()
            if key in allowed_limits
            and (value is None or (type(value) in (int, float) and math.isfinite(value)))
        }
    return safe


def _private_file(path: Path) -> None:
    """Create a private regular file without following a final-component symlink."""
    if path.is_symlink():
        raise ValueError("Tracking files must not be symbolic links")
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Tracking files must be regular files")
        if hasattr(os, "fchmod"):  # Not on Windows, where the mode means little.
            os.fchmod(fd, 0o600)
    finally:
        os.close(fd)


class Tracker:
    """SQLite receipts. Use a dedicated directory such as ``.state/tracking.sqlite``.

    The dedicated parent is set to 0700. Connections are opened per operation so
    independent tasks/processes can share a database using WAL and busy timeout.
    """

    def __init__(self, path: Path):
        self.receipts_complete = True
        self.path = Path(path).expanduser().absolute()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path.parent.chmod(0o700)
        _private_file(self.path)
        with self._db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
                    started_at TEXT NOT NULL, finished_at TEXT,
                    status TEXT NOT NULL, mode TEXT NOT NULL,
                    config_hash TEXT NOT NULL, config_json TEXT NOT NULL,
                    metadata_json TEXT NOT NULL, answer_hash TEXT, score REAL
                );
                CREATE TABLE IF NOT EXISTS calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES runs(id),
                    created_at TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
                    input_tokens INTEGER, output_tokens INTEGER,
                    latency_ms REAL NOT NULL, status TEXT NOT NULL,
                    input_rate REAL, output_rate REAL, cost_usd REAL,
                    billable INTEGER NOT NULL, metadata_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES runs(id),
                    created_at TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id);
                CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
                CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC, id DESC);
            """)

    def mark_incomplete(self) -> None:
        """Runtime-only, monotonic health; successful later writes cannot repair a gap."""
        self.receipts_complete = False

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = None
        try:
            db = sqlite3.connect(self.path, timeout=20)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db
        except (sqlite3.Error, OSError):
            self.mark_incomplete()
            raise
        finally:
            if db is not None:
                try:
                    db.close()
                except (sqlite3.Error, OSError):
                    self.mark_incomplete()
                    raise

    def start_run(
        self, task_id: str, config: dict, mode: str = "mock", metadata: dict | None = None
    ) -> str:
        run_id = str(uuid.uuid4())
        with self._db() as db:
            db.execute(
                "INSERT INTO runs (id,task_id,started_at,status,mode,config_hash,"
                "config_json,metadata_json) VALUES (?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    _label(task_id),
                    _now(),
                    "running",
                    _label(mode),
                    _digest(config),
                    _json(_safe_config(config)),
                    _json(_safe_metadata(metadata)),
                ),
            )
        return run_id

    def event(self, run_id: str, kind: str, data: dict) -> None:
        with self._db() as db:
            db.execute(
                "INSERT INTO events (run_id,created_at,kind,data_json) VALUES (?,?,?,?)",
                (run_id, _now(), _label(kind), _json(_safe_event(data))),
            )

    def record_call(
        self,
        run_id: str,
        provider: str,
        model: str,
        input_tokens: int | None,
        output_tokens: int | None,
        latency_ms: float,
        status: str,
        input_rate: float | None = None,
        output_rate: float | None = None,
        **kwargs,
    ) -> None:
        for value in (input_tokens, output_tokens):
            if value is not None and (type(value) is not int or value < 0):
                raise ValueError("Token usage must be a nonnegative integer or None")
        for value in (input_rate, output_rate):
            if value is not None and (
                type(value) not in (int, float) or not math.isfinite(value) or value < 0
            ):
                raise ValueError("Prices must be finite nonnegative numbers or None")
        if not math.isfinite(latency_ms) or latency_ms < 0:
            raise ValueError("Latency must be finite and nonnegative")
        billable = provider != "mock"
        cost = None
        if not billable:
            cost = 0.0
        elif all(x is not None for x in (input_tokens, output_tokens, input_rate, output_rate)):
            cost = (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000
        with self._db() as db:
            db.execute(
                "INSERT INTO calls (run_id,created_at,provider,model,input_tokens,"
                "output_tokens,latency_ms,status,input_rate,output_rate,cost_usd,billable,"
                "metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    _now(),
                    _label(provider),
                    _label(model),
                    input_tokens,
                    output_tokens,
                    latency_ms,
                    _label(status),
                    input_rate,
                    output_rate,
                    cost,
                    billable,
                    _json(_safe_event(kwargs)),
                ),
            )

    def finish_run(
        self, run_id: str, status: str, answer: dict | None = None, score: float | None = None
    ) -> None:
        if score is not None and not math.isfinite(score):
            raise ValueError("Score must be finite or None")
        with self._db() as db:
            cursor = db.execute(
                "UPDATE runs SET finished_at=?,status=?,answer_hash=?,score=? WHERE id=?",
                (
                    _now(),
                    _label(status),
                    _digest(answer) if answer is not None else None,
                    score,
                    run_id,
                ),
            )
            if cursor.rowcount != 1:
                raise KeyError("Unknown tracking run")

    @staticmethod
    def _row(row: sqlite3.Row) -> dict:
        result = dict(row)
        for key in list(result):
            if key.endswith("_json"):
                result[key[:-5]] = json.loads(result.pop(key))
        if "billable" in result:
            result["billable"] = bool(result["billable"])
        return result

    def runs(self, limit: int = 50) -> list[dict]:
        if type(limit) is not int or not 1 <= limit <= 10000:
            raise ValueError("Run limit must be between 1 and 10000")
        with self._db() as db:
            return [
                self._row(row)
                for row in db.execute(
                    "SELECT * FROM runs ORDER BY started_at DESC,id DESC LIMIT ?", (limit,)
                )
            ]

    def calls(self, run_id: str) -> list[dict]:
        with self._db() as db:
            return [
                self._row(row)
                for row in db.execute("SELECT * FROM calls WHERE run_id=? ORDER BY id", (run_id,))
            ]

    def spend(self) -> dict:
        """Live requests over the whole database: what the team's allowance has paid for.

        Replayed cache hits and mock calls cost nothing. Tokens and cost cover
        the calls that reported them, so both are lower bounds.
        """
        with self._db() as db:
            rows = [
                row
                for row in db.execute("SELECT * FROM calls WHERE billable=1")
                if not _cache_hit(row)
            ]
        return {
            "calls": len(rows),
            "tokens": sum((row["input_tokens"] or 0) + (row["output_tokens"] or 0) for row in rows),
            "usd": sum(row["cost_usd"] or 0.0 for row in rows),
            "unknown_cost_calls": sum(row["cost_usd"] is None for row in rows),
        }

    def summary(self, run_id: str | None = None) -> dict:
        with self._db() as db:
            db.execute("BEGIN")
            where = " WHERE run_id=?" if run_id is not None else ""
            params = (run_id,) if run_id is not None else ()
            rows = list(db.execute("SELECT * FROM calls" + where, params))
            run_where = " WHERE id=?" if run_id is not None else ""
            run_count = db.execute("SELECT COUNT(*) FROM runs" + run_where, params).fetchone()[0]
        return self._summary(rows, run_count)

    @staticmethod
    def _summary(rows: list, run_count: int) -> dict:
        known_input = sum(row["input_tokens"] or 0 for row in rows)
        known_output = sum(row["output_tokens"] or 0 for row in rows)
        input_complete = all(row["input_tokens"] is not None for row in rows)
        output_complete = all(row["output_tokens"] is not None for row in rows)
        unknown_cost_calls = sum(row["cost_usd"] is None for row in rows)
        known_cost = sum(row["cost_usd"] or 0 for row in rows)
        return {
            "run_count": run_count,
            "calls": len(rows),
            "mock_calls": sum(not row["billable"] for row in rows),
            # Replayed replies: counted with their original usage, paid for only once.
            "cache_hits": sum(_cache_hit(row) for row in rows),
            "input_tokens": known_input if input_complete else None,
            "output_tokens": known_output if output_complete else None,
            "total_tokens": known_input + known_output
            if input_complete and output_complete
            else None,
            "known_input_tokens": known_input,
            "known_output_tokens": known_output,
            "usage_complete": input_complete and output_complete,
            "known_cost_usd": known_cost,
            "cost_usd": None if unknown_cost_calls else known_cost,
            "unknown_cost_calls": unknown_cost_calls,
            "latency_ms": sum(row["latency_ms"] for row in rows),
        }

    def export(self, path: Path) -> None:
        destination = Path(path).expanduser().absolute()
        storage = [self.path, Path(str(self.path) + "-wal"), Path(str(self.path) + "-shm")]
        if any(destination.resolve() == item.resolve() for item in storage):
            raise ValueError("Export must not overwrite the tracking database")
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        _private_file(destination)
        # Open first, compare actual inode identities, then truncate. This also
        # protects against a destination that is a hardlink to a SQLite file.
        fd = os.open(destination, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            opened = os.fstat(stream.fileno())
            for item in storage:
                if item.exists():
                    existing = item.stat()
                    if (opened.st_dev, opened.st_ino) == (existing.st_dev, existing.st_ino):
                        raise ValueError("Export must not overwrite a tracking storage file")
            with self._db() as db:
                db.execute("BEGIN")
                runs = [self._row(row) for row in db.execute("SELECT * FROM runs")]
                calls = [self._row(row) for row in db.execute("SELECT * FROM calls")]
                payload = {
                    "schema_version": 1,
                    "exported_at": _now(),
                    "cost_basis": "Configured price estimates; not a provider invoice",
                    "summary": self._summary(calls, len(runs)),
                    "runs": runs,
                    "calls": calls,
                    "events": [self._row(row) for row in db.execute("SELECT * FROM events")],
                }
            stream.truncate(0)
            stream.write(json.dumps(payload, sort_keys=True, indent=2, allow_nan=False) + "\n")


class NoReceipts:
    """Stands in for the tracker where nothing can be written.

    An evaluation container may have no writable place at all. Receipts serve
    our own measurements; the answers must still be produced.
    """

    path = None
    receipts_complete = False

    def mark_incomplete(self) -> None:
        return

    def start_run(self, *args: Any, **kwargs: Any) -> str:
        return str(uuid.uuid4())

    def event(self, *args: Any, **kwargs: Any) -> None:
        return

    def record_call(self, *args: Any, **kwargs: Any) -> None:
        return

    def finish_run(self, *args: Any, **kwargs: Any) -> None:
        return

    def calls(self, run_id: str) -> list[dict]:
        return []

    def runs(self, limit: int = 50) -> list[dict]:
        return []

    def spend(self) -> dict:
        return {"calls": 0, "tokens": 0, "usd": 0.0, "unknown_cost_calls": 0}

    def summary(self, run_id: str | None = None) -> dict:
        return Tracker._summary([], 0)
