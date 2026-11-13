"""Exercise real POSIX signals only inside an isolated, model-free subprocess."""

import json
import os
import signal
import subprocess
import sys

import pytest


@pytest.mark.skipif(os.name != "posix", reason="optimizer process groups require POSIX")
@pytest.mark.parametrize("first_signal", [signal.SIGINT, signal.SIGTERM])
def test_repeated_interrupts_do_not_reenter_cleanup_or_abort_receipt_finalization(
    tmp_path,
    first_signal,
):
    script = r'''
import json
import os
import signal
import sqlite3
import sys
from pathlib import Path

from hacklab import optimize

events = []
cleanup_calls = 0

def cleanup():
    global cleanup_calls
    cleanup_calls += 1
    current = cleanup_calls
    events.append(f"cleanup_enter_{current}")
    if current == 1:
        os.kill(os.getpid(), signal.SIGINT)
        os.kill(os.getpid(), signal.SIGTERM)
    events.append(f"cleanup_complete_{current}")

optimize._cleanup_owned = cleanup
for number in (signal.SIGINT, signal.SIGTERM):
    signal.signal(number, optimize._interrupted)
db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE campaigns(status TEXT); INSERT INTO campaigns VALUES('running');
CREATE TABLE trials(status TEXT); INSERT INTO trials VALUES('running');
""")
try:
    try:
        os.kill(os.getpid(), int(sys.argv[2]))
    finally:
        events.append("receipts_begin")
        with db:
            db.execute("UPDATE campaigns SET status='unknown_cost'")
            os.kill(os.getpid(), signal.SIGINT)
            os.kill(os.getpid(), signal.SIGTERM)
            db.execute("UPDATE trials SET status='error'")
        events.append("receipts_committed")
finally:
    result = {
        "events": events,
        "cleanup_calls": cleanup_calls,
        "campaign_status": db.execute("SELECT status FROM campaigns").fetchone()[0],
        "trial_status": db.execute("SELECT status FROM trials").fetchone()[0],
    }
    Path(sys.argv[1]).write_text(json.dumps(result))
    db.close()
'''
    output = tmp_path / "signals.json"
    result = subprocess.run(
        [sys.executable, "-c", script, str(output), str(int(first_signal))],
        start_new_session=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 128 + first_signal, result.stderr
    recorded = json.loads(output.read_text())
    assert recorded == {
        "events": ["cleanup_enter_1", "cleanup_complete_1", "receipts_begin", "receipts_committed"],
        "cleanup_calls": 1,
        "campaign_status": "unknown_cost",
        "trial_status": "error",
    }
