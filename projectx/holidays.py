"""
CME holiday and early-close days for 2026 and 2027, as the Topstep guard uses them.

Same data and rules as projectx-gateway/src/holidays.js (tests/fixtures/holidays.json pins
both). Cautious by design; docs/topstep-rules-sources.md explains the sources and the gaps.

* Every product is treated as halting at the EARLIEST time seen, 13:00 ET (12:00 CT).
* Topstep closes positions 15 minutes before any early close, so the guard stops entries 35
  minutes before the close and flattens 20 minutes before it.
* A "closed" day blocks the whole trading day named by its date (from the previous evening's
  18:00 ET reset to its own reset), like a weekend.
* Rows are keyed by the trading-day key (the date the session ends on).
* ``verified`` is False everywhere: not confirmed against CME, and the 2027 rows are derived
  from U.S. holiday rules.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

HOLIDAY_TIMEZONE = "America/New_York"

HOLIDAY_RULES = {
    "earlyCloseEt": "13:00",
    "topstepCutoffMinBeforeClose": 15,
    "flatMinBeforeClose": 20,
    "noEntryMinBeforeClose": 35,
}

_VERIFIED_ON = "2026-10-25"
_SRC_2026 = ("https://crosstrade.io/blog/cme-trading-hours-2026; "
             "https://damnpropfirms.com/trading-guides/cme-holiday-schedule/")
_SRC_2027 = ("derived from U.S. holiday rules (CME 2027 calendar not published when written); "
             "https://help.topstep.com/en/articles/13350348-topstep-holiday-trading-hours")


def _closed(date: str, name: str, source: str) -> dict:
    return {"date": date, "name": name, "type": "closed", "closeEt": None,
            "source": source, "verified": False, "verifiedOn": _VERIFIED_ON}


def _early(date: str, name: str, source: str) -> dict:
    return {"date": date, "name": name, "type": "early", "closeEt": HOLIDAY_RULES["earlyCloseEt"],
            "source": source, "verified": False, "verifiedOn": _VERIFIED_ON}


HOLIDAYS = (
    _closed("2026-01-01", "New Year's Day", _SRC_2026),
    _early("2026-01-19", "Martin Luther King Jr. Day", _SRC_2026),
    _early("2026-02-16", "Presidents' Day", _SRC_2026),
    _closed("2026-04-03", "Good Friday (jobs report day, special CME settlement)", _SRC_2026),
    _early("2026-05-25", "Memorial Day", _SRC_2026),
    _early("2026-06-19", "Juneteenth", _SRC_2026),
    _early("2026-07-03", "Independence Day (observed)", _SRC_2026),
    _early("2026-09-07", "Labor Day", _SRC_2026),
    _early("2026-11-26", "Thanksgiving Day", _SRC_2026),
    _early("2026-11-27", "Day after Thanksgiving", _SRC_2026),
    _early("2026-12-24", "Christmas Eve", _SRC_2026),
    _closed("2026-12-25", "Christmas Day", _SRC_2026),
    _closed("2027-01-01", "New Year's Day", _SRC_2027),
    _early("2027-01-18", "Martin Luther King Jr. Day", _SRC_2027),
    _early("2027-02-15", "Presidents' Day", _SRC_2027),
    _closed("2027-03-26", "Good Friday", _SRC_2027),
    _early("2027-05-31", "Memorial Day", _SRC_2027),
    _early("2027-06-18", "Juneteenth (observed, a guess: 19 Jun is a Saturday)", _SRC_2027),
    _early("2027-07-05", "Independence Day (observed)", _SRC_2027),
    _early("2027-09-06", "Labor Day", _SRC_2027),
    _early("2027-11-25", "Thanksgiving Day", _SRC_2027),
    _early("2027-11-26", "Day after Thanksgiving", _SRC_2027),
    _closed("2027-12-24", "Christmas Day (observed)", _SRC_2027),
)

_BY_DATE = {h["date"]: h for h in HOLIDAYS}


def holiday_for(key: str) -> dict | None:
    """The holiday row for a trading-day key ("YYYY-MM-DD"), or None."""
    return _BY_DATE.get(key)


def early_close_times(row: dict | None) -> tuple[datetime, datetime, datetime] | None:
    """(close, no_entry, flat) as aware datetimes for an early-close row, None for a closed day."""
    if not row or row["type"] != "early":
        return None
    y, m, d = (int(x) for x in row["date"].split("-"))
    hh, mm = (int(x) for x in row["closeEt"].split(":"))
    close = datetime(y, m, d, hh, mm, tzinfo=ZoneInfo(HOLIDAY_TIMEZONE))
    return (
        close,
        close - timedelta(minutes=HOLIDAY_RULES["noEntryMinBeforeClose"]),
        close - timedelta(minutes=HOLIDAY_RULES["flatMinBeforeClose"]),
    )
