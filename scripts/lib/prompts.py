"""Prompt template loading and substitution.

Templates use string.Template ($var) rather than str.format — the templates
talk about GIFT and JSON, so literal braces are frequent and must survive.
Validation happens on the TEMPLATE, not on the rendered text: substituted
content (a transcript, a session prompt) may legitimately contain $-words,
so scanning the output would false-positive. Instead the template's
identifiers must exactly be covered by the provided variables (missing one
raises; an unused variable only warns — it may be intentional per-template).
"""

from __future__ import annotations

import sys
from pathlib import Path
from string import Template


class PromptError(Exception):
    pass


def load_template(path: Path) -> str:
    if not path.exists():
        raise PromptError(f"prompt template not found: {path}")
    return path.read_text(encoding="utf-8")


def _identifiers(tmpl: Template, text: str) -> set[str]:
    ids: set[str] = set()
    for match in tmpl.pattern.finditer(text):
        if match.group("invalid") is not None:
            raise PromptError(f"malformed '$' placeholder in template near: {text[match.start():match.start() + 30]!r}")
        name = match.group("named") or match.group("braced")
        if name:
            ids.add(name)
    return ids


def render(template_text: str, variables: dict[str, object]) -> str:
    tmpl = Template(template_text)
    ids = _identifiers(tmpl, template_text)
    missing = ids - variables.keys()
    if missing:
        raise PromptError(f"prompt template references {sorted('$' + m for m in missing)} but no value was provided")
    unused = variables.keys() - ids
    if unused:
        print(f"⚠️  prompt variables provided but not used by template: {sorted(unused)}", file=sys.stderr)
    return tmpl.substitute({k: str(v) for k, v in variables.items()})
