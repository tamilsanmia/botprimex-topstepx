"""
HTTP client for the projectx-gateway sidecar.

The gateway answers errors as ``{"error": ..., "kind": "<ccxt exception name>"}``
so they can be re-raised here as the matching ccxt exception; Freqtrade decides
whether to retry from the exception class.
"""

from __future__ import annotations

import json
import os
from typing import Any

import ccxt
import requests

DEFAULT_URL = "http://projectx-gateway:8787"
DEFAULT_TIMEOUT = 15


def gateway_settings(config: dict | None = None, options: dict | None = None) -> tuple[str, str]:
    """Resolve gateway URL and shared secret from ccxt options, Freqtrade config or env."""
    opts = dict(options or {})
    if config:
        ccxt_opts = config.get("exchange", {}).get("ccxt_config", {}).get("options", {})
        opts = {**ccxt_opts, **opts}
    url = os.environ.get("PROJECTX_GATEWAY_URL") or opts.get("gatewayUrl") or DEFAULT_URL
    secret = os.environ.get("GATEWAY_SECRET") or opts.get("gatewaySecret") or ""
    return url.rstrip("/"), secret


def raise_for_payload(status: int, payload: Any, method: str, path: str) -> None:
    if status < 400:
        return
    kind = "ExchangeError"
    message = f"projectx-gateway {method} {path} returned HTTP {status}"
    if isinstance(payload, dict):
        kind = payload.get("kind") or kind
        message = payload.get("error") or message
    if status == 429:
        kind = "RateLimitExceeded"
    exc = getattr(ccxt, kind, None)
    if not (isinstance(exc, type) and issubclass(exc, ccxt.BaseError)):
        exc = ccxt.ExchangeError
    raise exc(f"projectx {message}")


class GatewayClient:
    """Synchronous client with a keep-alive session (one localhost round trip per call)."""

    def __init__(self, url: str = DEFAULT_URL, secret: str = "", timeout: float = DEFAULT_TIMEOUT):
        self.url = url.rstrip("/")
        self.secret = secret
        self.timeout = timeout
        self._session: requests.Session | None = None

    @classmethod
    def from_config(cls, config: dict | None = None, options: dict | None = None) -> "GatewayClient":
        url, secret = gateway_settings(config, options)
        return cls(url, secret)

    @property
    def session(self) -> requests.Session:
        if self._session is None:
            self._session = requests.Session()
            self._session.headers.update({"Content-Type": "application/json"})
            if self.secret:
                self._session.headers["X-Gateway-Secret"] = self.secret
        return self._session

    def request(self, method: str, path: str, query: dict | None = None, body: dict | None = None) -> Any:
        params = {k: v for k, v in (query or {}).items() if v is not None}
        try:
            resp = self.session.request(
                method,
                f"{self.url}{path}",
                params=params,
                data=json.dumps(body) if body is not None else None,
                timeout=self.timeout,
            )
        except requests.Timeout as e:
            raise ccxt.RequestTimeout(f"projectx-gateway timeout on {path}: {e}") from e
        except requests.RequestException as e:
            raise ccxt.ExchangeNotAvailable(f"projectx-gateway unreachable on {path}: {e}") from e
        try:
            payload = resp.json()
        except ValueError:
            payload = None
        raise_for_payload(resp.status_code, payload, method, path)
        return payload

    def get(self, path: str, query: dict | None = None) -> Any:
        return self.request("GET", path, query=query)

    def post(self, path: str, body: dict | None = None) -> Any:
        return self.request("POST", path, body=body or {})

    def close(self) -> None:
        if self._session is not None:
            self._session.close()
            self._session = None
