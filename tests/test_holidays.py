"""The Python holiday table must equal the Node one (tests/fixtures/holidays.json)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import projectx  # noqa: F401
from projectx import holidays

SNAPSHOT = json.loads((Path(__file__).parent / "fixtures" / "holidays.json").read_text())


def test_table_matches_the_node_snapshot():
    assert holidays.HOLIDAY_TIMEZONE == SNAPSHOT["timezone"]
    assert holidays.HOLIDAY_RULES == SNAPSHOT["rules"]
    assert list(holidays.HOLIDAYS) == SNAPSHOT["holidays"]


def test_lookup_and_early_close_times():
    assert holidays.holiday_for("2026-10-20") is None
    assert holidays.holiday_for("2026-04-03")["type"] == "closed"
    assert holidays.early_close_times(holidays.holiday_for("2026-04-03")) is None
    close, no_entry, flat = holidays.early_close_times(holidays.holiday_for("2026-05-25"))
    assert close.astimezone(timezone.utc) == datetime(2026, 5, 25, 17, 0, tzinfo=timezone.utc)
    assert (close - no_entry).total_seconds() == 35 * 60
    assert (close - flat).total_seconds() == 20 * 60
    est_close = holidays.early_close_times(holidays.holiday_for("2026-11-26"))[0]
    assert est_close.astimezone(timezone.utc) == datetime(2026, 11, 26, 18, 0, tzinfo=timezone.utc)
