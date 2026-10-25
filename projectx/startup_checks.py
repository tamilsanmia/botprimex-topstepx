"""
Start-up checks that refuse to run with unsafe configuration.

The REST/WebSocket API server can place and close orders, so it must not run with
the placeholder secrets from the example configs.
"""

from __future__ import annotations

from freqtrade.exceptions import ConfigurationError

PLACEHOLDER = "change-me"
SECRET_KEYS = ("jwt_secret_key", "ws_token", "password")
# Backtesting, hyperopt and data downloads never serve the API.
CHECKED_RUNMODES = ("live", "dry_run", "webserver")


def _values(value) -> list[str]:
    """ws_token may be one string or a list of them."""
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value] or [""]
    return [str(value) if value is not None else ""]


def check_api_server_secrets(config: dict) -> None:
    api = config.get("api_server") or {}
    if not api.get("enabled"):
        return
    bad = []
    for key in SECRET_KEYS:
        values = _values(api.get(key))
        if any(not v.strip() or PLACEHOLDER in v.lower() for v in values):
            bad.append(key)
    if bad:
        raise ConfigurationError(
            "api_server is enabled but " + ", ".join(f"api_server.{k}" for k in bad)
            + f" is empty or still a placeholder ('{PLACEHOLDER}'). The API can place and close orders: "
            "set long random values (or disable api_server)."
        )


def check_startup(config: dict) -> None:
    """Runs the checks for the run modes that serve the API (trade and webserver)."""
    runmode = config.get("runmode")
    if getattr(runmode, "value", runmode) in CHECKED_RUNMODES:
        check_api_server_secrets(config)
