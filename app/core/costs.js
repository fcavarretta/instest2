// Cost observability — JS port of scripts/lib/costs.py. Estimates only; the
// billing truth is Google's console. Vault rule: cost statements name who pays
// (Gemini calls are pay-per-use on FC's card).

const round4 = (x) => Math.round(x * 10000) / 10000;

export function estimate(usage, pricing) {
  const table = pricing[usage.model];
  if (!table) return { tier: "unknown-model", usd: null };
  const threshold = Math.trunc(table.long_threshold_tokens ?? 200000);
  const longTier = usage.promptTokens > threshold;
  const rateIn = Number(longTier ? table.input_long : table.input);
  const rateOut = Number(longTier ? table.output_long : table.output);
  const usd = (usage.promptTokens * rateIn + (usage.outputTokens + usage.thoughtsTokens) * rateOut) / 1_000_000;
  return { tier: longTier ? "long" : "standard", usd: round4(usd) };
}

export function usageMetadata(usages, pricing) {
  const calls = [];
  let totalUsd = 0;
  let priced = true;
  for (const u of usages) {
    const est = estimate(u, pricing);
    if (est.usd === null) priced = false;
    else totalUsd += est.usd;
    calls.push({
      call: u.call,
      model: u.model,
      resolved_model: u.resolvedModel || u.model,
      prompt_tokens: u.promptTokens,
      output_tokens: u.outputTokens,
      thoughts_tokens: u.thoughtsTokens,
      total_tokens: u.totalTokens,
      wall_seconds: Math.round(u.wallSeconds * 10) / 10,
      pricing_tier: est.tier,
      usd_estimate: est.usd,
    });
  }
  return { calls, total_usd_estimate: priced ? round4(totalUsd) : null };
}

export function consoleSummary(usages, pricing) {
  return usages
    .map((u) => {
      const est = estimate(u, pricing);
      const usd = est.usd !== null ? `≈ $${est.usd.toFixed(2)}` : "(no pricing entry)";
      return `${u.call}: ${Math.round(u.promptTokens / 1000)}k in / ${(u.outputTokens / 1000).toFixed(1)}k out (+${(u.thoughtsTokens / 1000).toFixed(1)}k thinking) in ${Math.round(u.wallSeconds)}s ${usd}`;
    })
    .join("\n");
}
