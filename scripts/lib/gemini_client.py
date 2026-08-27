"""Gemini REST client — stdlib only (urllib), per the vault precedent
(image-generate skill / nano_banana.py) and FC's 2026-08-25 decision: no SDK.

The inline-base64 route caps the request around 20 MB, i.e. ~14 MB of raw
media before the 4/3 base64 overhead. The compression preflight keeps even a
2-hour recording under that: transcode to mono 32 kbps MP3 (Gemini downmixes
to 16 kHz mono internally, so nothing useful is lost), cached beside the
source. If compression ever falls short, the upgrade path is the Files API
(resumable upload) — confined to this module by design.

The API key is passed in and never logged or included in error messages.
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from .config import CallSettings, RunConfig
from .costs import CallUsage

API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
MAX_INLINE_SOURCE_BYTES = 14 * 1024 * 1024
COMPRESS_SUFFIX = "_c32k.mp3"
RETRY_STATUS = {429, 500, 502, 503, 504}
RETRY_DELAYS = (5, 20, 60)
TIMEOUT_SECONDS = 1800

MIME_TYPES = {
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/plain",
}

# Enforced server-side via responseSchema; re-validated client-side in questions.py.
QUESTIONS_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["mcq", "truefalse"]},
                    "name": {"type": "string"},
                    "stem": {"type": "string"},
                    "correct": {"type": "string"},
                    "distractors": {"type": "array", "items": {"type": "string"}},
                    "answer": {"type": "boolean"},
                    "feedback": {"type": "string"},
                },
                "required": ["type", "name", "stem"],
            },
        }
    },
    "required": ["questions"],
}


class ApiError(Exception):
    pass


class TruncationError(ApiError):
    """finishReason == MAX_TOKENS; carries the partial text for salvage."""

    def __init__(self, message: str, partial_text: str):
        super().__init__(message)
        self.partial_text = partial_text


def mime_for(path: Path) -> str:
    mime = MIME_TYPES.get(path.suffix.lower())
    if not mime:
        raise ApiError(f"unsupported file type '{path.suffix}' for {path.name} (known: {sorted(MIME_TYPES)})")
    return mime


def prepare_audio(path: Path) -> Path:
    """Compression preflight: return the source if it fits inline, else a
    cached mono-32kbps MP3 transcode (reused when newer than the source)."""
    if not path.exists():
        raise ApiError(f"audio file not found: {path}")
    size = path.stat().st_size
    if size <= MAX_INLINE_SOURCE_BYTES:
        return path

    cache = path.with_name(path.stem + COMPRESS_SUFFIX)
    if cache.exists() and cache.stat().st_mtime >= path.stat().st_mtime:
        print(f"🔊 {path.name} is {size / 1e6:.0f} MB — reusing compressed cache {cache.name}")
        return cache

    if not shutil.which("ffmpeg"):
        raise ApiError(
            f"{path.name} is {size / 1e6:.0f} MB (> {MAX_INLINE_SOURCE_BYTES / 1e6:.0f} MB inline cap) "
            "and ffmpeg is not available to compress it — install ffmpeg, or implement the Files API upgrade"
        )
    print(f"🔊 {path.name} is {size / 1e6:.0f} MB — compressing to mono 32 kbps MP3 (one-time, cached)")
    result = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1", "-b:a", "32k", str(cache)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ApiError(f"ffmpeg failed on {path.name}: {result.stderr.strip()[:500]}")
    new_size = cache.stat().st_size
    print(f"   → {cache.name}: {new_size / 1e6:.1f} MB")
    return cache


UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files"


def upload_file(path: Path, api_key: str) -> dict:
    """Files API resumable upload — for audio beyond the inline cap. Two HTTP
    calls (start -> upload+finalize), then poll until the file is ACTIVE.
    Returns the file info dict (its 'uri' goes into a file_data part)."""
    data = path.read_bytes()
    mime = mime_for(path)
    try:
        start = urllib.request.Request(
            UPLOAD_URL,
            data=json.dumps({"file": {"display_name": path.name}}).encode(),
            headers={
                "x-goog-api-key": api_key,
                "Content-Type": "application/json",
                "X-Goog-Upload-Protocol": "resumable",
                "X-Goog-Upload-Command": "start",
                "X-Goog-Upload-Header-Content-Length": str(len(data)),
                "X-Goog-Upload-Header-Content-Type": mime,
            },
            method="POST",
        )
        with urllib.request.urlopen(start, timeout=60) as r:
            upload_url = r.headers.get("X-Goog-Upload-URL")
        if not upload_url:
            raise ApiError("Files API: no upload URL returned")
        up = urllib.request.Request(
            upload_url,
            data=data,
            headers={"X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0"},
            method="POST",
        )
        with urllib.request.urlopen(up, timeout=600) as r:
            info = json.loads(r.read().decode("utf-8"))["file"]
    except urllib.error.HTTPError as e:
        raise ApiError(f"Files API upload HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:400]}") from e
    except urllib.error.URLError as e:
        raise ApiError(f"Files API upload network error: {e.reason}") from e
    name = info.get("name", "")
    for _ in range(60):
        if info.get("state") == "ACTIVE":
            return info
        time.sleep(2)
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/{name}", headers={"x-goog-api-key": api_key}
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            info = json.loads(r.read().decode("utf-8"))
    raise ApiError(f"Files API: uploaded file never became ACTIVE (state: {info.get('state')})")


def _inline_part(path: Path) -> dict:
    return {
        "inline_data": {
            "mime_type": mime_for(path),
            "data": base64.b64encode(path.read_bytes()).decode("ascii"),
        }
    }


def _generation_config(settings: CallSettings, json_schema: dict | None) -> dict:
    cfg: dict = {"maxOutputTokens": settings.max_output_tokens, "temperature": settings.temperature}
    if settings.thinking_level is not None:
        cfg["thinkingConfig"] = {"thinkingLevel": settings.thinking_level}
    elif settings.thinking_budget is not None:
        cfg["thinkingConfig"] = {"thinkingBudget": settings.thinking_budget}
    if json_schema is not None:
        cfg["responseMimeType"] = "application/json"
        cfg["responseSchema"] = json_schema
    return cfg


def _post(model: str, body: dict, api_key: str, fast_fail: bool = False) -> dict:
    url = f"{API_BASE}/{model}:generateContent"
    payload = json.dumps(body).encode("utf-8")
    delays = () if fast_fail else RETRY_DELAYS
    last_error = "no attempt made"
    for attempt in range(len(delays) + 1):
        request = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:800]
            last_error = f"API HTTP {e.code}: {detail}"
            if e.code not in RETRY_STATUS:
                raise ApiError(last_error) from e
        except urllib.error.URLError as e:
            last_error = f"network error: {e.reason}"
        if attempt < len(delays):
            delay = delays[attempt]
            print(f"   retrying in {delay}s ({last_error[:120]})", file=sys.stderr)
            time.sleep(delay)
    raise ApiError(f"giving up after {len(delays) + 1} attempts — {last_error}")


def _extract(data: dict) -> tuple[str, str]:
    candidates = data.get("candidates")
    if not candidates:
        block = (data.get("promptFeedback") or {}).get("blockReason", "unknown")
        raise ApiError(f"no candidates in response (blockReason: {block})")
    candidate = candidates[0]
    finish = candidate.get("finishReason", "UNKNOWN")
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(part.get("text", "") for part in parts)
    if not text:
        raise ApiError(f"response contains no text (finishReason: {finish}, message: {candidate.get('finishMessage', '—')})")
    return text, finish


def call_model(
    model: str,
    parts: list[dict],
    settings: CallSettings,
    api_key: str,
    *,
    call_name: str,
    json_schema: dict | None = None,
    fast_fail: bool = False,
) -> tuple[str, CallUsage]:
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": _generation_config(settings, json_schema),
    }
    start = time.monotonic()
    data = _post(model, body, api_key, fast_fail=fast_fail)
    text, finish = _extract(data)
    um = data.get("usageMetadata") or {}
    usage = CallUsage(
        call=call_name,
        model=model,
        prompt_tokens=int(um.get("promptTokenCount", 0)),
        output_tokens=int(um.get("candidatesTokenCount", 0)),
        thoughts_tokens=int(um.get("thoughtsTokenCount", 0)),
        total_tokens=int(um.get("totalTokenCount", 0)),
        wall_seconds=time.monotonic() - start,
        resolved_model=str(data.get("modelVersion", "")),
    )
    if finish == "MAX_TOKENS":
        raise TruncationError(
            f"{call_name} hit max_output_tokens ({settings.max_output_tokens}) — output truncated "
            "(raise the limit, or the session needs the deferred chunking option)",
            partial_text=text,
        )
    if finish not in ("STOP", "UNKNOWN"):
        print(f"⚠️  {call_name}: finishReason={finish}", file=sys.stderr)
    return text, usage


def transcribe(cfg: RunConfig, prompt_text: str, api_key: str) -> tuple[str, CallUsage]:
    audio = prepare_audio(cfg.audio_file)
    size = audio.stat().st_size
    if size <= MAX_INLINE_SOURCE_BYTES:
        first: dict = _inline_part(audio)
    else:
        print(f"📤 {audio.name} ({size / 1e6:.0f} MB) exceeds the inline cap — uploading via the Files API…")
        info = upload_file(audio, api_key)
        print(f"   uploaded ✓ (Google keeps it 48 h)")
        first = {"file_data": {"mime_type": mime_for(audio), "file_uri": info["uri"]}}
    parts = [first, {"text": prompt_text}]
    return call_model(cfg.model_transcription, parts, cfg.transcription, api_key, call_name="transcription")


def generate_questions(cfg: RunConfig, prompt_text: str, api_key: str) -> tuple[str, CallUsage]:
    total = 0
    parts: list[dict] = []
    for context_path in cfg.context_files:
        if not context_path.exists():
            raise ApiError(f"context file not found: {context_path}")
        total += context_path.stat().st_size
        parts.append(_inline_part(context_path))
    if total > MAX_INLINE_SOURCE_BYTES:
        raise ApiError(f"context files total {total / 1e6:.0f} MB > inline cap — trim or compress them")
    parts.append({"text": prompt_text})
    return call_model(
        cfg.model_generation, parts, cfg.generation, api_key, call_name="generation", json_schema=QUESTIONS_SCHEMA
    )
