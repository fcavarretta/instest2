"""Cost observability: token counts per call + $ estimate from the pricing
table in system.yaml. Estimates only — the billing truth is Google's console.
Vault rule: cost statements name who pays; Gemini calls are pay-per-use on
FC's card (see Instructions.md, API Credentials convention)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CallUsage:
    call: str                # "transcription" | "generation"
    model: str               # requested name (pricing table key)
    prompt_tokens: int
    output_tokens: int       # candidates
    thoughts_tokens: int     # billed as output
    total_tokens: int
    wall_seconds: float
    resolved_model: str = ""  # what an alias like gemini-pro-latest actually served


def estimate(usage: CallUsage, pricing: dict[str, Any]) -> dict[str, Any]:
    table = pricing.get(usage.model)
    if not table:
        return {"tier": "unknown-model", "usd": None}
    threshold = int(table.get("long_threshold_tokens", 200_000))
    long_tier = usage.prompt_tokens > threshold
    rate_in = float(table["input_long"] if long_tier else table["input"])
    rate_out = float(table["output_long"] if long_tier else table["output"])
    usd = (usage.prompt_tokens * rate_in + (usage.output_tokens + usage.thoughts_tokens) * rate_out) / 1_000_000
    return {"tier": "long" if long_tier else "standard", "usd": round(usd, 4)}


def usage_metadata(usages: list[CallUsage], pricing: dict[str, Any]) -> dict[str, Any]:
    calls = []
    total_usd = 0.0
    priced = True
    for u in usages:
        est = estimate(u, pricing)
        if est["usd"] is None:
            priced = False
        else:
            total_usd += est["usd"]
        calls.append(
            {
                "call": u.call,
                "model": u.model,
                "resolved_model": u.resolved_model or u.model,
                "prompt_tokens": u.prompt_tokens,
                "output_tokens": u.output_tokens,
                "thoughts_tokens": u.thoughts_tokens,
                "total_tokens": u.total_tokens,
                "wall_seconds": round(u.wall_seconds, 1),
                "pricing_tier": est["tier"],
                "usd_estimate": est["usd"],
            }
        )
    return {"calls": calls, "total_usd_estimate": round(total_usd, 4) if priced else None}


def console_summary(usages: list[CallUsage], pricing: dict[str, Any]) -> str:
    lines = []
    for u in usages:
        est = estimate(u, pricing)
        usd = f"≈ ${est['usd']:.2f}" if est["usd"] is not None else "(no pricing entry)"
        lines.append(
            f"{u.call}: {u.prompt_tokens / 1000:.0f}k in / {u.output_tokens / 1000:.1f}k out"
            f" (+{u.thoughts_tokens / 1000:.1f}k thinking) in {u.wall_seconds:.0f}s {usd}"
        )
    return "\n".join(lines)
