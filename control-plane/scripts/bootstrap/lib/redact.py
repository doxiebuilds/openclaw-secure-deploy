#!/usr/bin/env python3
"""Redact secrets and long opaque tokens from probe output."""

from __future__ import annotations

import json
import re
from typing import Any

# Long base64-ish / token-ish strings
_TOKEN_RE = re.compile(r"(?i)(token|password|secret|authorization|bearer)([\"'=\s:]+)([A-Za-z0-9_\-+/=]{16,})")
_OPAQUE_RE = re.compile(r"\b[A-Za-z0-9_-]{40,}\b")

_SENSITIVE_KEYS = {
    "token",
    "authToken",
    "password",
    "secret",
    "authorization",
    "botToken",
    "appToken",
    "deviceToken",
    "privateKey",
    "publicKey",
    "signature",
}


def redact_text(text: str) -> str:
    text = _TOKEN_RE.sub(r"\1\2REDACTED", text)
    # Collapse long opaques only when they look like ids/tokens (keep short hashes)
    def _opaque(m: re.Match[str]) -> str:
        s = m.group(0)
        if len(s) >= 40:
            return "REDACTED"
        return s

    return _OPAQUE_RE.sub(_opaque, text)


def redact_obj(obj: Any) -> Any:
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if k in _SENSITIVE_KEYS or k.lower().endswith("token") or k.lower().endswith("password"):
                out[k] = "REDACTED"
            else:
                out[k] = redact_obj(v)
        return out
    if isinstance(obj, list):
        return [redact_obj(x) for x in obj]
    if isinstance(obj, str):
        return redact_text(obj)
    return obj


def dumps_redacted(obj: Any, **kwargs: Any) -> str:
    return json.dumps(redact_obj(obj), **kwargs)
