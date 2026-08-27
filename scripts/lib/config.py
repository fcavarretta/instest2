"""Configuration cascade: system.yaml -> course.yaml -> session.yaml.

The CLI receives ONE path: the session YAML. course.yaml is discovered
structurally (courses/<CODE>/sessions/x.yaml -> courses/<CODE>/course.yaml);
system.yaml defaults to <2 Dev>/resources/system.yaml, overridable.

Merge rule: dicts merge recursively, scalars and lists REPLACE (later layer
wins). Single documented exception: context_files, where course-level and
session-level lists are APPENDED — a session adds its slides to the course
syllabus, it does not evict it.

Relative paths in a YAML resolve against that YAML's own directory.
"""

from __future__ import annotations

import datetime
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

LANG_NAMES = {"fr": "French", "en": "English"}

DEFAULT_SYSTEM_PATH = Path(__file__).resolve().parents[2] / "resources" / "system.yaml"

# question_count may live at any layer (lowest wins) — hence known everywhere.
KNOWN_SYSTEM_KEYS = {"models", "reserve_percent", "transcription", "generation", "output_root", "prompts", "gift", "pricing", "question_count"}
KNOWN_COURSE_KEYS = {"course_code", "course_name", "dominant_language", "question_language", "course_prompt", "context_files", "schedule", "question_count"}
KNOWN_SESSION_KEYS = {"session_id", "session_date", "audio_file", "session_prompt", "question_count", "question_language", "context_files"}


class ConfigError(Exception):
    """Configuration problem; message always names the file and key."""


@dataclass(frozen=True)
class CallSettings:
    max_output_tokens: int
    temperature: float
    thinking_budget: int | None = None  # Gemini 2.5-era control (token count)
    thinking_level: str | None = None   # Gemini 3 control ("low" | "high"); mutually exclusive with budget


@dataclass(frozen=True)
class RunConfig:
    # models
    model_transcription: str
    model_generation: str
    transcription: CallSettings
    generation: CallSettings
    # course identity
    course_code: str
    course_name: str
    dominant_language: str
    question_language: str
    course_prompt: str
    # session — id/date/prompt are optional (FC, 2026-08-25)
    session_id: int | str | None   # only used to prefix question names (S3-Q01); None → plain Q01
    session_date: str              # defaults to today when absent
    session_prompt: str            # defaults to empty, like course_prompt
    audio_file: Path | None      # optional in YAML: Colab passes --audio instead
    context_files: tuple[Path, ...]
    # question counts
    question_count: int
    reserve_percent: int
    question_count_total: int
    # output & resources
    output_root: Path | None     # optional override; default = beside the audio file
    prompt_transcription: Path
    prompt_generation: Path
    gift_category_header: bool
    pricing: dict[str, Any] = field(default_factory=dict)


def load_yaml(path: Path) -> dict:
    if not path.exists():
        raise ConfigError(f"{path}: file not found")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        raise ConfigError(f"{path}: invalid YAML — {e}") from e
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: top level must be a mapping, got {type(data).__name__}")
    return data


def deep_merge(base: dict, override: dict) -> dict:
    """Dicts merge recursively; scalars and lists replace."""
    merged = dict(base)
    for key, value in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _warn_unknown(data: dict, known: set[str], path: Path) -> None:
    for key in data:
        if key not in known:
            print(f"⚠️  {path}: unknown key '{key}' (typo?)", file=sys.stderr)


def _require(data: dict, key: str, path: Path) -> Any:
    if key not in data or data[key] is None:
        raise ConfigError(f"{path}: missing required key '{key}'")
    return data[key]


def _resolve(base_dir: Path, value: str) -> Path:
    p = Path(value)
    return p if p.is_absolute() else (base_dir / p).resolve()


CONTEXT_EXTENSIONS = {".pdf", ".txt", ".md"}
# Pipeline outputs never make sense as context (attaching the transcript would
# duplicate it on top of the prompt); excluded from folder/glob expansion.
_OUTPUT_MARKERS = (".transcript", ".questions", ".metadata", ".log")


def _eligible_context(f: Path) -> bool:
    return f.is_file() and f.suffix.lower() in CONTEXT_EXTENSIONS and not any(m in f.name for m in _OUTPUT_MARKERS)


def _context_files(data: dict, path: Path) -> list[Path]:
    raw = data.get("context_files") or []
    if not isinstance(raw, list):
        raise ConfigError(f"{path}: 'context_files' must be a list")
    result: list[Path] = []
    for item in raw:
        item = str(item)
        p = _resolve(path.parent, item)
        if "*" in item or "?" in item:
            matches = sorted(f for f in p.parent.glob(p.name) if _eligible_context(f))
            if not matches:
                print(f"⚠️  {path}: context pattern '{item}' matched no {sorted(CONTEXT_EXTENSIONS)} files (outputs excluded)", file=sys.stderr)
            result.extend(matches)
        elif p.is_dir():
            expanded = sorted(f for f in p.iterdir() if _eligible_context(f))
            if not expanded:
                print(f"⚠️  {path}: context folder '{item}' contains no {sorted(CONTEXT_EXTENSIONS)} files (outputs excluded)", file=sys.stderr)
            result.extend(expanded)
        else:
            result.append(p)  # explicit single file: taken as-is, even an output, deliberately
    return result


def _language(value: Any, key: str, path: Path) -> str:
    lang = str(value).lower()
    if lang not in LANG_NAMES:
        raise ConfigError(f"{path}: '{key}' must be one of {sorted(LANG_NAMES)}, got '{value}'")
    return lang


def _call_settings(data: dict, section: str, path: Path) -> CallSettings:
    sub = data.get(section)
    if not isinstance(sub, dict):
        raise ConfigError(f"{path}: missing section '{section}'")
    budget = sub.get("thinking_budget")
    level = sub.get("thinking_level")
    if budget is not None and level is not None:
        raise ConfigError(f"{path}: '{section}' sets both thinking_budget and thinking_level — the API rejects that; keep one")
    if level is not None and str(level) not in ("low", "high"):
        raise ConfigError(f"{path}: '{section}.thinking_level' must be 'low' or 'high', got '{level}'")
    return CallSettings(
        max_output_tokens=int(_require(sub, "max_output_tokens", path)),
        temperature=float(_require(sub, "temperature", path)),
        thinking_budget=None if budget is None else int(budget),
        thinking_level=None if level is None else str(level),
    )


def find_course_yaml(session_path: Path, course_path: Path | str | None = None) -> Path:
    """Explicit course path wins (notebook COURSE field / --course); fallback:
    a file named course.yaml two levels above the session file."""
    if course_path:
        course_path = Path(course_path).resolve()
        if not course_path.exists():
            raise ConfigError(f"{course_path}: course file not found (given via --course / COURSE)")
        return course_path
    fallback = session_path.parent.parent / "course.yaml"
    if not fallback.exists():
        raise ConfigError(
            f"no course file: pass one explicitly (notebook COURSE field / --course), "
            f"or place course.yaml two levels above the session file (looked at {fallback})"
        )
    return fallback


def load_config(
    session_path: Path,
    system_path: Path | None = None,
    model_transcription: str | None = None,
    model_generation: str | None = None,
    course_path: Path | str | None = None,
) -> RunConfig:
    session_path = Path(session_path).resolve()
    system_path = Path(system_path).resolve() if system_path else DEFAULT_SYSTEM_PATH
    course_path = find_course_yaml(session_path, course_path)

    system = load_yaml(system_path)
    course = load_yaml(course_path)
    session = load_yaml(session_path)
    _warn_unknown(system, KNOWN_SYSTEM_KEYS, system_path)
    _warn_unknown(course, KNOWN_COURSE_KEYS, course_path)
    _warn_unknown(session, KNOWN_SESSION_KEYS, session_path)

    # context_files append across layers (the one exception to list-replace);
    # resolved per-layer against each file's own directory, then removed so the
    # generic merge below never sees them.
    context_files = _context_files(course, course_path) + _context_files(session, session_path)
    course = {k: v for k, v in course.items() if k != "context_files"}
    session = {k: v for k, v in session.items() if k != "context_files"}

    merged = deep_merge(deep_merge(system, course), session)

    models = merged.get("models")
    if not isinstance(models, dict):
        raise ConfigError(f"{system_path}: missing section 'models'")
    prompts = merged.get("prompts")
    if not isinstance(prompts, dict):
        raise ConfigError(f"{system_path}: missing section 'prompts'")

    if merged.get("question_count") is None:
        raise ConfigError(
            "question_count is not set at any layer — set it once in "
            f"{system_path.name}, {course_path.name}, or {session_path.name} (lowest level wins)"
        )
    question_count = int(merged["question_count"])
    reserve_percent = int(_require(merged, "reserve_percent", system_path))
    if question_count <= 0 or reserve_percent < 0:
        raise ConfigError(f"{session_path}: question_count must be > 0 and reserve_percent >= 0")

    raw_id = merged.get("session_id")
    if raw_id is None:
        session_id: int | str | None = None
    else:
        try:
            session_id = int(raw_id)
        except (TypeError, ValueError):
            session_id = str(raw_id)

    return RunConfig(
        model_transcription=model_transcription or str(_require(models, "transcription", system_path)),
        model_generation=model_generation or str(_require(models, "generation", system_path)),
        transcription=_call_settings(merged, "transcription", system_path),
        generation=_call_settings(merged, "generation", system_path),
        course_code=str(_require(merged, "course_code", course_path)),
        course_name=str(_require(merged, "course_name", course_path)),
        dominant_language=_language(_require(merged, "dominant_language", course_path), "dominant_language", course_path),
        question_language=_language(_require(merged, "question_language", course_path), "question_language", course_path),
        course_prompt=str(merged.get("course_prompt") or ""),
        session_id=session_id,
        session_date=str(merged["session_date"]) if merged.get("session_date") else datetime.date.today().isoformat(),
        session_prompt=str(merged.get("session_prompt") or ""),
        audio_file=_resolve(session_path.parent, str(merged["audio_file"])) if merged.get("audio_file") else None,
        context_files=tuple(context_files),
        question_count=question_count,
        reserve_percent=reserve_percent,
        question_count_total=math.ceil(question_count * (1 + reserve_percent / 100)),
        output_root=_resolve(system_path.parent, str(merged["output_root"])) if merged.get("output_root") else None,
        prompt_transcription=_resolve(system_path.parent, str(_require(prompts, "transcription", system_path))),
        prompt_generation=_resolve(system_path.parent, str(_require(prompts, "generation", system_path))),
        gift_category_header=bool((merged.get("gift") or {}).get("category_header", True)),
        pricing=merged.get("pricing") or {},
    )


def other_language(lang: str) -> str:
    return "en" if lang == "fr" else "fr"
