"""
Topstep rules for backtests and hyperopt.

Live and dry-run trading get their verdict from the gateway's AccountGuard. A
backtest replays history far faster than real time, so asking the gateway every
candle would be both slow and wrong (it would judge today's account, not the
replayed one). This evaluates the same rules from the backtest's own closed
trades and returns the same dict shape the gateway does, so the strategy code
path is identical.

The gateway's projectx-gateway/src/guard.js is the reference. The two are kept in
step by tests/fixtures/guard_parity.json, which both test suites run.

What is modelled: the session clock (entry windows, flat_by, weekends, CME holidays
and early closes, news blackouts, trading windows), the Daily Loss Limit and the
Maximum Loss Limit on realized plus open P&L (the caller passes the open P&L as
`unrealized`), the three MLL types (trailing_eod on balances snapshotted at eod_time,
trailing_intraday on peak equity, static), the MLL lock balance and buffer, daily_loss_type,
profit target with the consistency modes (cap_day, raise_target, off), the profit giveback
lock, trade and consecutive-loss counters, and the funded scaling plan.

Not modelled: the contract cap against open positions (the strategy mixin checks it
against its own trades) and data staleness (backtest data is never stale).

`phase` and `preset` set to "auto" (or left out) are resolved from `topstep.account_name`
(50KTC -> evaluation 50K, XFA -> funded, LFA -> live_funded) or, for the size, from a numeric
`start_balance`. When that does not resolve, or a required limit has no value, construction
raises ConfigurationError: there is no silent 50K evaluation.
"""

from __future__ import annotations

import math
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from freqtrade.exceptions import ConfigurationError

from .holidays import early_close_times, holiday_for

PRESETS = {
    50000: {
        "evaluation": {"profit_target": 3000, "daily_loss_limit": 1000, "max_loss_limit": 2000, "max_mini_equivalent": 5},
        "funded": {"daily_loss_limit": 1000, "max_loss_limit": 2000, "max_mini_equivalent": 5,
                   "scaling_plan": [{"min_profit": 0, "max_mini_equivalent": 2},
                                    {"min_profit": 1500, "max_mini_equivalent": 3},
                                    {"min_profit": 2000, "max_mini_equivalent": 5}]},
    },
    100000: {
        "evaluation": {"profit_target": 6000, "daily_loss_limit": 2000, "max_loss_limit": 3000, "max_mini_equivalent": 10},
        "funded": {"daily_loss_limit": 2000, "max_loss_limit": 3000, "max_mini_equivalent": 10,
                   "scaling_plan": [{"min_profit": 0, "max_mini_equivalent": 3},
                                    {"min_profit": 1500, "max_mini_equivalent": 4},
                                    {"min_profit": 2000, "max_mini_equivalent": 6},
                                    {"min_profit": 3000, "max_mini_equivalent": 10}]},
    },
    150000: {
        "evaluation": {"profit_target": 9000, "daily_loss_limit": 3000, "max_loss_limit": 4500, "max_mini_equivalent": 15},
        "funded": {"daily_loss_limit": 3000, "max_loss_limit": 4500, "max_mini_equivalent": 15,
                   "scaling_plan": [{"min_profit": 0, "max_mini_equivalent": 3},
                                    {"min_profit": 1500, "max_mini_equivalent": 4},
                                    {"min_profit": 2000, "max_mini_equivalent": 5},
                                    {"min_profit": 3000, "max_mini_equivalent": 10},
                                    {"min_profit": 4500, "max_mini_equivalent": 15}]},
    },
}
_FUNDED_DEFAULTS = {
    "profit_target": None, "daily_loss_limit": None, "max_loss_limit": None, "max_loss_type": "trailing_eod",
    "daily_loss_type": "intraday", "mll_lock_balance": 0, "consistency_pct": None, "consistency_mode": "cap_day",
    "max_mini_equivalent": None, "stop_on_target": False, "scaling_plan": None,
}
PHASE_DEFAULTS = {
    "evaluation": {
        "profit_target": None, "daily_loss_limit": None, "max_loss_limit": None, "max_loss_type": "trailing_eod",
        "daily_loss_type": "intraday", "mll_lock_balance": None, "consistency_pct": 55, "consistency_mode": "cap_day",
        "max_mini_equivalent": None, "stop_on_target": True, "scaling_plan": None,
    },
    "funded": dict(_FUNDED_DEFAULTS),
    # A Live Funded Account starts at its size, not $0: the XFA lock balance of 0 would switch the MLL off.
    "live_funded": {**_FUNDED_DEFAULTS, "mll_lock_balance": None},
}
SESSION_DEFAULTS = {
    "reset_time": "18:00", "eod_time": "16:10", "no_entry_before": "18:05", "no_entry_after": "15:45",
    "flat_by": "16:05", "hold_mode": "intraday", "trading_windows": [], "trade_weekends": False,
    "news_blackout": [], "use_holiday_calendar": True,
}
PROTECTION_DEFAULTS = {
    "dll_soft_pct": 70, "dll_hard_pct": 90, "mll_buffer": 300, "max_risk_per_trade": 250,
    "max_trades_per_day": 10, "max_consecutive_losses": 3,
    "daily_profit_lock": {"enabled": True, "activate_at": 800, "giveback_pct": 40},
}
CONSISTENCY_MODES = ("cap_day", "raise_target", "off")
KIND_PHASE = {"TC": "evaluation", "XFA": "funded", "PA": "funded", "LFA": "live_funded"}
# Express Funded and Topstep Labs accounts build their balance from $0; the others start at size.
STARTS_AT_ZERO = {"XFA", "LABS"}
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
RANK = {"active": 0, "entries_blocked": 1, "day_locked": 2, "account_locked": 3}
_ACCOUNT = re.compile(r"^(\d+)K(TC|XFA|LFA|PA)(?![A-Z])")
# Topstep Labs Challenge, e.g. "6KCHCR-LABS005-V2-...": a profit-only balance that starts at $0.
_LABS = re.compile(r"^(\d+)KCHCR-LABS")


def account_product(name: Any) -> tuple[int | None, str | None]:
    """(size in USD, product code) from an account name like "50KTC-V2-1", as the gateway reads it."""
    upper = str(name or "").strip().upper()
    match = _ACCOUNT.match(upper)
    labs = None if match else _LABS.match(upper)
    if not match and not labs:
        return None, None
    thousands = int((match or labs).group(1))
    return (thousands * 1000 if thousands > 0 else None), (match.group(2) if match else "LABS")


def _round2(v: float) -> float:
    # Math.round semantics (half rounds up), as in the gateway, not Python's banker's rounding.
    return math.floor(v * 100 + 0.5) / 100


def _minutes(hhmm: str) -> int:
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", str(hhmm or "").strip())
    if not match or int(match.group(1)) > 23 or int(match.group(2)) > 59:
        raise ValueError(f'"{hhmm}" must be HH:MM')
    return int(match.group(1)) * 60 + int(match.group(2))


def _in_window(minutes: int, start: int, end: int) -> bool:
    if start == end:
        return False
    return start <= minutes < end if start < end else minutes >= start or minutes < end


def _days(spec) -> set[int]:
    if not spec or spec in ("*", "all"):
        return set(range(7))
    out: set[int] = set()
    for token in spec if isinstance(spec, list) else str(spec).split(","):
        token = token.strip().lower()
        if "-" in token:
            a, b = (DAYS.index(x[:3]) for x in token.split("-"))
            i = a
            while True:
                out.add(i)
                if i == b:
                    break
                i = (i + 1) % 7
        else:
            out.add(DAYS.index(token[:3]))
    return out


def _defined(d: dict | None) -> dict:
    return {k: v for k, v in (d or {}).items() if v is not None}


def _is_auto(v) -> bool:
    return v is None or v == "auto"


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class BacktestGuard:
    def __init__(self, config: dict):
        ts = config.get("topstep") or {}
        self.enabled = ts.get("enabled", True) is not False
        if self.enabled:
            self._resolve(ts)
        else:
            self.protection = {**PROTECTION_DEFAULTS}
        self.reset()

    # ------------------------------------------------------------- set-up --

    def _resolve(self, ts: dict) -> None:
        """phase <- preset <- user values, the way the gateway's resolveRules does it."""
        problems: list[str] = []
        account_size, kind = account_product(ts.get("account_name"))

        phase = ts.get("phase")
        if _is_auto(phase):
            phase = KIND_PHASE.get(kind)
            if not phase and kind == "LABS":
                problems.append(
                    f'topstep.phase is "auto" but topstep.account_name ({ts.get("account_name")}) is a Topstep Labs '
                    "account: there are no Labs rule presets, so set topstep.phase and the limits under "
                    "topstep.phases yourself (or set topstep.enabled to false)"
                )
            elif not phase:
                problems.append(
                    f'topstep.phase is "auto" but topstep.account_name ({ts.get("account_name") or "none"}) has no '
                    "recognised product code (50KTC, 100KXFA, 150KLFA ...); set phase to evaluation, funded or live_funded"
                )
        elif phase not in PHASE_DEFAULTS:
            problems.append(f'topstep.phase must be evaluation, funded or live_funded, got "{phase}"')
            phase = None

        preset = ts.get("preset")
        size: int | None
        if _is_auto(preset):
            size = account_size
            start_hint = ts.get("start_balance")
            if size is None and _num(start_hint) and start_hint > 0:
                size = int(start_hint)
            if size is None:
                problems.append(
                    'topstep.preset is "auto" but the account size is unknown: set topstep.account_name, '
                    'a numeric start_balance or preset ("50k", "100k", "150k")'
                )
        else:
            match = re.fullmatch(r"(\d+)k", str(preset).strip().lower())
            size = int(match.group(1)) * 1000 if match else None
            if size is None:
                problems.append(f'topstep.preset must be "auto", "50k", "100k" or "150k", got "{preset}"')

        start = ts.get("start_balance")
        if _is_auto(start):
            if kind in STARTS_AT_ZERO or (kind is None and phase == "funded"):
                start = 0
            else:
                start = size
        if not _num(start):
            problems.append('topstep.start_balance is "auto" but the account size is unknown; set it explicitly')
            start = 0

        phase_ok = phase in PHASE_DEFAULTS
        user = (ts.get("phases") or {}).get(phase) or {} if phase_ok else {}
        preset_key = "funded" if phase == "live_funded" else phase
        preset_rules = (PRESETS.get(size or 0, {}).get(preset_key, {})) if phase_ok else {}
        rules = {**(PHASE_DEFAULTS[phase] if phase_ok else {}), **preset_rules, **_defined(user)}
        rules.pop("session", None)
        rules.pop("payout", None)
        session = {**SESSION_DEFAULTS, **_defined(ts.get("session")), **_defined(user.get("session"))}
        protection = {**PROTECTION_DEFAULTS, **_defined(ts.get("protection"))}
        protection["daily_profit_lock"] = {
            **PROTECTION_DEFAULTS["daily_profit_lock"],
            **_defined((ts.get("protection") or {}).get("daily_profit_lock")),
        }
        timezone_name = ts.get("timezone") or "America/New_York"

        if phase_ok:
            self._validate(rules, session, protection, timezone_name, problems)
        if problems:
            raise ConfigurationError("Invalid topstep config:\n  - " + "\n  - ".join(problems))

        if isinstance(rules.get("scaling_plan"), list):
            rules["scaling_plan"] = sorted(rules["scaling_plan"], key=lambda x: x["min_profit"])
        self.phase = phase
        self.size = size
        self.start = float(start)
        self.rules = rules
        self.session = session
        self.protection = protection
        self.tz = ZoneInfo(timezone_name)
        self.t = {k: _minutes(session[k]) for k in ("reset_time", "eod_time", "no_entry_before", "no_entry_after", "flat_by")}
        self.windows = [(_minutes(w["start"]), _minutes(w["end"])) for w in session.get("trading_windows") or []]
        self.news = [(_days(w.get("days")), _minutes(w["start"]), _minutes(w["end"]), bool(w.get("flatten")))
                     for w in session.get("news_blackout") or []]

    @staticmethod
    def _validate(rules: dict, session: dict, protection: dict, tz: str, problems: list[str]) -> None:
        def positive(v, name, nullable=False):
            if v is None:
                if not nullable:
                    problems.append(f"{name} is required (no preset value for this account)")
            elif not (_num(v) and v > 0):
                problems.append(f"{name} must be a positive number, got {v}")

        def pct(v, name, nullable=False):
            if v is None and nullable:
                return
            if not (_num(v) and 0 < v <= 100):
                problems.append(f"{name} must be in (0, 100], got {v}")

        if rules.get("daily_loss_limit") not in (False, 0):
            positive(rules.get("daily_loss_limit"), "daily_loss_limit")
        positive(rules.get("max_loss_limit"), "max_loss_limit")
        positive(rules.get("profit_target"), "profit_target", nullable=True)
        if rules.get("consistency_pct") not in (0, False):
            pct(rules.get("consistency_pct"), "consistency_pct", nullable=True)
        if rules.get("max_loss_type") not in ("trailing_eod", "trailing_intraday", "static"):
            problems.append(f'max_loss_type must be trailing_eod, trailing_intraday or static, got "{rules.get("max_loss_type")}"')
        if rules.get("daily_loss_type") not in ("intraday", "eod"):
            problems.append(f'daily_loss_type must be intraday or eod, got "{rules.get("daily_loss_type")}"')
        if rules.get("consistency_mode") not in CONSISTENCY_MODES:
            problems.append(f'consistency_mode must be {", ".join(CONSISTENCY_MODES)}, got "{rules.get("consistency_mode")}"')
        lock = rules.get("mll_lock_balance")
        if lock is not None and not _num(lock):
            problems.append(f"mll_lock_balance must be a number or null, got {lock}")
        if rules.get("consistency_pct") and rules.get("consistency_mode") != "off" and not rules.get("profit_target"):
            problems.append("consistency_pct needs a profit_target to size the daily cap")
        plan = rules.get("scaling_plan")
        if isinstance(plan, list):
            for i, tier in enumerate(plan):
                if not _num((tier or {}).get("min_profit")):
                    problems.append(f"scaling_plan[{i}].min_profit must be a number")
                positive((tier or {}).get("max_mini_equivalent"), f"scaling_plan[{i}].max_mini_equivalent")
        else:
            positive(rules.get("max_mini_equivalent"), "max_mini_equivalent")

        try:
            ZoneInfo(tz)
        except Exception:  # noqa: BLE001
            problems.append(f'timezone "{tz}" is not a valid IANA timezone')
        for key in ("reset_time", "eod_time", "no_entry_before", "no_entry_after", "flat_by"):
            try:
                _minutes(session[key])
            except ValueError as e:
                problems.append(f"session.{key} {e}")
        if session.get("hold_mode") not in ("intraday", "overnight"):
            problems.append(f'session.hold_mode must be intraday or overnight, got "{session.get("hold_mode")}"')
        if not isinstance(session.get("use_holiday_calendar"), bool):
            problems.append(f'session.use_holiday_calendar must be true or false, got {session.get("use_holiday_calendar")!r}')
        for i, w in enumerate(session.get("trading_windows") or []):
            try:
                _minutes(w["start"]), _minutes(w["end"])
            except (KeyError, ValueError) as e:
                problems.append(f"trading_windows[{i}]: {e}")
        for i, w in enumerate(session.get("news_blackout") or []):
            try:
                _days(w.get("days")), _minutes(w["start"]), _minutes(w["end"])
            except (KeyError, ValueError) as e:
                problems.append(f"news_blackout[{i}]: {e}")

        pct(protection.get("dll_soft_pct"), "protection.dll_soft_pct")
        pct(protection.get("dll_hard_pct"), "protection.dll_hard_pct")
        if _num(protection.get("dll_soft_pct")) and _num(protection.get("dll_hard_pct")) \
                and protection["dll_soft_pct"] > protection["dll_hard_pct"]:
            problems.append("protection.dll_soft_pct must be <= dll_hard_pct")
        if not (_num(protection.get("mll_buffer")) and protection["mll_buffer"] >= 0):
            problems.append("protection.mll_buffer must be >= 0")
        for key in ("max_risk_per_trade", "max_trades_per_day", "max_consecutive_losses"):
            if protection.get(key) not in (0, False):
                positive(protection.get(key), f"protection.{key}", nullable=True)
        giveback = protection.get("daily_profit_lock") or {}
        if giveback.get("enabled"):
            positive(giveback.get("activate_at"), "protection.daily_profit_lock.activate_at")
            pct(giveback.get("giveback_pct"), "protection.daily_profit_lock.giveback_pct")

    def reset(self) -> None:
        """Back to the state of a fresh guard: no high-water marks, locks, day or EOD history."""
        self.hwm_eod: float | None = None
        self.hwm_intraday: float | None = None
        self.days: dict[str, dict] = {}
        self.last_eod_key: str | None = None
        self.day_key: str | None = None
        self.day_peak = 0.0
        self.day_lock: dict | None = None
        self.account_lock: dict | None = None
        self.last_day_realized: float | None = None

    # -------------------------------------------------------------- clock --

    def trading_day(self, now: datetime) -> dict:
        """{start, end, key, eod} of the trading day containing `now`; the key is the date it ends on."""
        local = now.astimezone(self.tz)
        reset = local.replace(hour=self.t["reset_time"] // 60, minute=self.t["reset_time"] % 60, second=0, microsecond=0)
        if local < reset:
            reset -= timedelta(days=1)
        end = reset + timedelta(days=1)
        key_date: date = end.date() if self.t["reset_time"] >= 12 * 60 else reset.date()
        eod = datetime.combine(key_date, time(self.t["eod_time"] // 60, self.t["eod_time"] % 60), tzinfo=self.tz)
        return {"start": reset.astimezone(timezone.utc), "end": end.astimezone(timezone.utc),
                "key": key_date.isoformat(), "eod": eod.astimezone(timezone.utc)}

    def session_start(self, now: datetime) -> datetime:
        if not self.enabled:
            # No session clock without the rules (topstep.enabled false): count the last 24 hours.
            return now - timedelta(hours=24)
        return self.trading_day(now)["start"]

    def _holiday(self, day: dict) -> dict | None:
        if self.session.get("use_holiday_calendar") is False:
            return None
        row = holiday_for(day["key"])
        if not row:
            return None
        return {"row": row, "closed": row["type"] == "closed", "times": early_close_times(row), "end": day["end"]}

    def _session_flags(self, now: datetime, day: dict) -> tuple[list[str], list[str]]:
        local = now.astimezone(self.tz)
        minutes = local.hour * 60 + local.minute
        wd = local.weekday()
        t = self.t
        block: list[str] = []
        flatten: list[str] = []
        weekend = wd == 5 or (wd == 4 and minutes >= t["flat_by"]) or (wd == 6 and minutes < t["reset_time"])
        if weekend and not self.session.get("trade_weekends"):
            return ["weekend"], ["weekend"]
        holiday = self._holiday(day)
        if holiday and holiday["closed"]:
            return ["holiday"], ["holiday"]
        if _in_window(minutes, t["no_entry_after"], t["no_entry_before"]):
            block.append("no_entry_window")
        if holiday and holiday["times"]:
            _close, no_entry, _flat = holiday["times"]
            if no_entry <= now < holiday["end"] and "no_entry_window" not in block:
                block.append("no_entry_window")
        if self.windows and not any(_in_window(minutes, a, b) for a, b in self.windows):
            block.append("outside_trading_windows")
        for days, a, b, flat_it in self.news:
            if wd in days and _in_window(minutes, a, b):
                block.append("news_blackout")
                if flat_it:
                    flatten.append("news_blackout")
        if self.session.get("hold_mode") == "intraday":
            after_early_flat = bool(holiday and holiday["times"] and holiday["times"][2] <= now < holiday["end"])
            if _in_window(minutes, t["flat_by"], t["reset_time"]) or after_early_flat:
                flatten.append("session_flat_by")
        return block, flatten

    def _max_mini(self, profit: float) -> float:
        plan = self.rules.get("scaling_plan")
        if plan:
            cap = plan[0]["max_mini_equivalent"]
            for tier in plan:
                if profit >= tier["min_profit"]:
                    cap = tier["max_mini_equivalent"]
            if self.rules.get("max_mini_equivalent"):
                cap = min(cap, self.rules["max_mini_equivalent"])
            return cap
        return self.rules["max_mini_equivalent"]

    # ----------------------------------------------------------- evaluate --

    def evaluate(
        self,
        now: datetime,
        closed: list[tuple[datetime, float]],
        entries_today: int,
        unrealized: float = 0.0,
    ) -> dict[str, Any]:
        """
        `closed` is [(close_time_utc, net_profit)] for every closed trade so far, `unrealized` the
        open P&L of the open trades at the current mark. Evaluate in time order: the guard keeps
        its end-of-day snapshots and high-water marks between calls (reset() clears them).
        """
        if not self.enabled:
            return {"status": "disabled", "canEnter": True, "flatten": False, "flattenReasons": [], "reasons": [],
                    "metrics": {"maxRiskPerTrade": self.protection.get("max_risk_per_trade")}}
        r, p = self.rules, self.protection
        day = self.trading_day(now)
        start = day["start"]
        ordered = sorted(closed, key=lambda x: x[0])
        balance = self.start + sum(v for _, v in ordered)
        today = [v for t, v in ordered if t >= start]
        day_realized = sum(today)
        unrealized = float(unrealized or 0.0)
        equity = balance + unrealized

        # A new trading day began. If the previous one was never snapshotted, close it from what is known now.
        if self.day_key != day["key"]:
            if self.day_key and self.last_eod_key != self.day_key and self.day_key not in self.days:
                balance_eod = balance - day_realized
                self.days[self.day_key] = {"pnl": _round2(self.last_day_realized or 0.0), "balanceEod": _round2(balance_eod)}
                self.hwm_eod = max(self.start if self.hwm_eod is None else self.hwm_eod, balance_eod)
                self.last_eod_key = self.day_key
            self.day_key = day["key"]
            self.day_peak = 0.0
            if self.day_lock and self.day_lock["key"] != day["key"]:
                self.day_lock = None
        self.last_day_realized = _round2(day_realized)

        # End-of-day snapshot: feeds the EOD high-water mark, best day and scaling.
        if now >= day["eod"] and self.last_eod_key != day["key"]:
            self.days[day["key"]] = {"pnl": _round2(day_realized + unrealized), "balanceEod": _round2(equity)}
            self.hwm_eod = max(self.start if self.hwm_eod is None else self.hwm_eod, equity)
            self.last_eod_key = day["key"]

        day_pnl = day_realized + (unrealized if r.get("daily_loss_type") == "intraday" else 0.0)
        if day_pnl > self.day_peak:
            self.day_peak = day_pnl
        day_loss = max(0.0, -day_pnl)
        total_profit = balance - self.start

        # Maximum Loss Limit floor.
        if r.get("max_loss_type") == "trailing_intraday":
            hwm = max(self.start if self.hwm_intraday is None else self.hwm_intraday, self.start, equity)
            self.hwm_intraday = hwm
        elif r.get("max_loss_type") == "trailing_eod":
            hwm = max(self.start if self.hwm_eod is None else self.hwm_eod, self.start)
        else:
            hwm = self.start
        floor = hwm - r["max_loss_limit"]
        if r.get("max_loss_type") != "static" and r.get("mll_lock_balance") is not None:
            floor = min(floor, float(r["mll_lock_balance"]))
        mll_room = equity - floor

        past = [d["pnl"] for k, d in self.days.items() if k != day["key"]]
        best_day = max([day_realized, *past, 0.0])
        mode = r.get("consistency_mode") or "cap_day"
        pct = r["consistency_pct"] / 100 if mode != "off" and r.get("consistency_pct") else None
        target = r.get("profit_target")
        consistency_cap = pct * target if mode == "cap_day" and pct and target else None
        consistency_ok = not pct or total_profit <= 0 or best_day <= pct * total_profit
        effective_target = max(target, best_day / pct if pct else 0.0) if target else None

        last_eod = self.days[self.last_eod_key]["balanceEod"] if self.last_eod_key in self.days else None
        scaling_profit = (last_eod if last_eod is not None else balance) - self.start
        max_mini = self._max_mini(scaling_profit)

        tail = 0
        for v in reversed(today):
            if v < 0:
                tail += 1
            else:
                break

        reasons: list[dict] = []

        def add(level: str, code: str, detail: str | None = None) -> None:
            reasons.append({"level": level, "code": code, "detail": detail})

        def lock_account(code: str, detail: str) -> None:
            if not self.account_lock:
                self.account_lock = {"reason": code, "detail": detail}
            if not any(x["code"] == code for x in reasons):
                add("account_locked", code, detail)

        def lock_day(code: str, detail: str) -> None:
            if not self.day_lock or self.day_lock["key"] != day["key"]:
                self.day_lock = {"key": day["key"], "reason": code, "detail": detail}
            if not any(x["code"] == code for x in reasons):
                add("day_locked", code, detail)

        if self.account_lock:
            add("account_locked", self.account_lock["reason"], self.account_lock["detail"])
        if mll_room <= p["mll_buffer"]:
            lock_account("mll_buffer", f"equity {_round2(equity)} is {_round2(mll_room)} above the MLL floor {_round2(floor)} (buffer {p['mll_buffer']})")
        if target and r.get("stop_on_target") and total_profit >= effective_target:
            lock_account("target_passed", f"profit {_round2(total_profit)} reached target {_round2(effective_target)}")

        if self.day_lock and self.day_lock["key"] == day["key"]:
            add("day_locked", self.day_lock["reason"], self.day_lock["detail"])
        dll = r.get("daily_loss_limit") or None
        if dll and day_loss >= dll * (p["dll_hard_pct"] / 100):
            lock_day("dll_hard", f"day loss {_round2(day_loss)} >= {p['dll_hard_pct']}% of DLL {dll}")
        giveback = p.get("daily_profit_lock") or {}
        if giveback.get("enabled") and self.day_peak >= giveback["activate_at"] \
                and self.day_peak - day_pnl >= (giveback["giveback_pct"] / 100) * self.day_peak:
            lock_day("profit_giveback", f"day P&L {_round2(day_pnl)} gave back {giveback['giveback_pct']}% of peak {_round2(self.day_peak)}")

        if dll and day_loss >= dll * (p["dll_soft_pct"] / 100):
            add("entries_blocked", "dll_soft", f"day loss {_round2(day_loss)} >= {p['dll_soft_pct']}% of DLL {dll}")
        if consistency_cap and day_pnl >= consistency_cap:
            add("entries_blocked", "consistency_cap", f"day P&L {_round2(day_pnl)} >= consistency cap {_round2(consistency_cap)}")
        if p.get("max_trades_per_day") and entries_today >= p["max_trades_per_day"]:
            add("entries_blocked", "max_trades_per_day", f"{entries_today} entries today")
        if p.get("max_consecutive_losses") and tail >= p["max_consecutive_losses"]:
            add("entries_blocked", "max_consecutive_losses", f"{tail} losses in a row")

        block, flatten = self._session_flags(now, day)
        for code in block:
            add("entries_blocked", code)

        status = max((x["level"] for x in reasons), key=RANK.get, default="active")
        if status in ("day_locked", "account_locked"):
            flatten.insert(0, status)
        holiday = self._holiday(day)
        return {
            "status": status,
            "canEnter": status == "active",
            "flatten": bool(flatten),
            "flattenReasons": flatten,
            "reasons": reasons,
            "tradingDay": day["key"],
            "holiday": ({"date": holiday["row"]["date"], "name": holiday["row"]["name"], "type": holiday["row"]["type"],
                         "closeEt": holiday["row"]["closeEt"]} if holiday else None),
            "sessionStart": int(start.timestamp() * 1000),
            "metrics": {
                "balance": _round2(balance),
                "unrealized": _round2(unrealized),
                "equity": _round2(equity),
                "startBalance": self.start,
                "totalProfit": _round2(total_profit),
                "dayRealized": _round2(day_realized),
                "dayPnl": _round2(day_pnl),
                "dayPeakPnl": _round2(self.day_peak),
                "dailyLossLimit": dll,
                "dayLossRemaining": _round2(dll - day_loss) if dll else None,
                "mllType": r.get("max_loss_type"),
                "mllFloor": _round2(floor),
                "mllRoom": _round2(mll_room),
                "highWater": _round2(hwm),
                "profitTarget": target,
                "effectiveTarget": _round2(effective_target) if effective_target is not None else None,
                "targetProgressPct": _round2(total_profit / effective_target * 100) if effective_target else None,
                "consistencyPct": r.get("consistency_pct"),
                "consistencyMode": mode,
                "consistencyCap": _round2(consistency_cap) if consistency_cap is not None else None,
                "consistencyOk": bool(consistency_ok),
                "bestDay": _round2(best_day),
                "maxMiniEquivalent": max_mini,
                "maxRiskPerTrade": p.get("max_risk_per_trade"),
                "entriesToday": entries_today,
                "consecutiveLosses": tail,
            },
        }
