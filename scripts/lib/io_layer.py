"""The ONLY environment-specific module (decision D5 of the brainstorm).

Everything else is plain Python running identically on the local machine and
in Colab. Two things differ per environment and both live here:

- secrets: GEMINI_API_KEY from (in order) the process environment, Colab's
  userdata secrets, or a local KEY=value env file (vault convention:
  /workspaces/___Vault/.env/gemini.env, overridable via --env-file);
- environment detection, so callers can adapt default paths if ever needed.

The key value is never printed, logged, or echoed (vault credential rule).
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

DEFAULT_ENV_FILE = Path("/workspaces/___Vault") / ".env" / "gemini.env"
KEY_NAME = "GEMINI_API_KEY"


class SecretError(Exception):
    pass


def in_colab() -> bool:
    return importlib.util.find_spec("google.colab") is not None


def _clean(value: str | None) -> str | None:
    """A pasted secret may carry stray newlines/quotes/duplicates (seen 2026-08-25:
    key pasted twice into the Colab secret → newline-joined → invalid HTTP header).
    Keep the first non-empty line, stripped."""
    if not value:
        return None
    for line in str(value).splitlines():
        line = line.strip().strip('"').strip("'")
        if line:
            return line
    return None


def _from_env_file(env_path: Path) -> str | None:
    # Same parser as the vault's image-generate skill (nano_banana.py):
    # KEY=value lines, '#' comments allowed, quotes stripped, other keys ignored.
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() == KEY_NAME:
            return v.strip().strip('"').strip("'")
    return None


def get_api_key(env_file: str | Path | None = None) -> str:
    key = _clean(os.environ.get(KEY_NAME))
    if key:
        return key

    if in_colab():
        from google.colab import userdata  # type: ignore

        try:
            key = _clean(userdata.get(KEY_NAME))
        except Exception:
            key = None
        if key:
            return key

    env_path = Path(env_file) if env_file else DEFAULT_ENV_FILE
    key = _clean(_from_env_file(env_path))
    if key:
        return key

    raise SecretError(
        f"{KEY_NAME} not found: not in the process environment, "
        f"{'not in Colab userdata, ' if in_colab() else ''}"
        f"and no usable entry in {env_path}"
    )
