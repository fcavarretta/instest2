"""Question model: parse and validate the JSON payload returned by Call 2.

The API is asked for {"questions": [...]} via responseSchema, but schema
enforcement does not survive output truncation and does not check semantic
constraints (index in range, distinct options), so everything is re-validated
here. Whitespace is normalized on entry: GIFT forbids raw newlines inside a
field, so stems/options/feedback are collapsed to single-line strings.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass

TYPES = {"mcq", "truefalse"}
NAME_MAX = 40
EXPECTED_OPTIONS = 4

_WS = re.compile(r"\s+")


class QuestionError(Exception):
    pass


@dataclass(frozen=True)
class Question:
    qtype: str                       # "mcq" | "truefalse"
    name: str                        # <= NAME_MAX chars, for the ::name:: title
    stem: str
    options: tuple[str, ...] | None  # mcq only
    correct_index: int | None        # mcq only
    answer: bool | None              # truefalse only
    feedback: str


def _norm(value: object) -> str:
    return _WS.sub(" ", str(value)).strip()


def _parse_one(item: dict, n: int) -> Question:
    where = f"question #{n}"
    if not isinstance(item, dict):
        raise QuestionError(f"{where}: expected an object, got {type(item).__name__}")

    qtype = _norm(item.get("type", "")).lower()
    if qtype not in TYPES:
        raise QuestionError(f"{where}: type must be one of {sorted(TYPES)}, got '{qtype}'")

    stem = _norm(item.get("stem", ""))
    if not stem:
        raise QuestionError(f"{where}: empty stem")

    name = _norm(item.get("name", "")) or f"q{n}"
    if len(name) > NAME_MAX:
        name = name[:NAME_MAX].rstrip()

    feedback = _norm(item.get("feedback", ""))

    options: tuple[str, ...] | None = None
    correct_index: int | None = None
    answer: bool | None = None

    if qtype == "mcq":
        # Primary format (2026-08-26): "correct" as TEXT + "distractors" — Gemini 3
        # reliably states the answer but omits bookkeeping like correct_index.
        if item.get("correct") is not None:
            correct = _norm(item["correct"])
            raw_d = item.get("distractors")
            if not correct or not isinstance(raw_d, list) or not raw_d:
                raise QuestionError(f"{where}: mcq needs 'correct' (text) and a 'distractors' list")
            options = (correct,) + tuple(_norm(d) for d in raw_d)
            correct_index = 0
        else:  # legacy format: options + correct_index
            raw_options = item.get("options")
            if not isinstance(raw_options, list) or len(raw_options) < 2:
                raise QuestionError(f"{where}: mcq needs 'correct'+'distractors' (or legacy 'options'+'correct_index')")
            options = tuple(_norm(o) for o in raw_options)
            ci = item.get("correct_index")
            if not isinstance(ci, int) or isinstance(ci, bool) or not (0 <= ci < len(options)):
                raise QuestionError(f"{where}: correct_index must be an integer in [0, {len(options) - 1}], got {ci!r}")
            correct_index = ci
        if any(not o for o in options):
            raise QuestionError(f"{where}: empty option")
        if len({o.lower() for o in options}) != len(options):
            raise QuestionError(f"{where}: duplicate options")
        if len(options) != EXPECTED_OPTIONS:
            print(f"⚠️  {where}: {len(options)} options (expected {EXPECTED_OPTIONS}) — kept", file=sys.stderr)
    else:
        raw_answer = item.get("answer")
        if not isinstance(raw_answer, bool):
            raise QuestionError(f"{where}: truefalse needs a boolean 'answer', got {raw_answer!r}")
        answer = raw_answer

    return Question(qtype, name, stem, options, correct_index, answer, feedback)


def parse_questions(raw: str) -> list[Question]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        raise QuestionError(
            f"model output is not valid JSON ({e}) — if the raw file ends mid-structure, "
            "the output was probably truncated (check finishReason / max_output_tokens)"
        ) from e
    if not isinstance(payload, dict) or not isinstance(payload.get("questions"), list):
        raise QuestionError("model output must be an object with a 'questions' list")
    items = payload["questions"]
    if not items:
        raise QuestionError("model returned an empty 'questions' list")
    # One malformed question must not kill the batch (seen 2026-08-26: an mcq
    # missing correct_index). Skip it LOUDLY; fail only if nothing survives.
    questions: list[Question] = []
    errors: list[str] = []
    for n, item in enumerate(items, start=1):
        try:
            questions.append(_parse_one(item, n))
        except QuestionError as e:
            errors.append(str(e))
            print(f"⚠️  skipped invalid {e}", file=sys.stderr)
    if not questions:
        raise QuestionError(f"all {len(items)} questions invalid — first error: {errors[0]}")
    if errors:
        print(f"⚠️  {len(errors)} of {len(items)} questions skipped — review coverage", file=sys.stderr)
    return questions


def check_count(questions: list[Question], expected_total: int, target: int) -> None:
    got = len(questions)
    if got < target:
        print(f"⚠️  only {got} questions for a target of {target} (asked {expected_total}) — review coverage", file=sys.stderr)
    elif got < expected_total:
        print(f"⚠️  {got} questions returned, {expected_total} asked (target {target} still met)", file=sys.stderr)
