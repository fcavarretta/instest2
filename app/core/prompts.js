// Prompt template loading and substitution — JS port of scripts/lib/prompts.py.
// Same contract as Python string.Template: $var / ${var}, $$ escapes a dollar,
// any other '$' is malformed. Validation happens on the TEMPLATE, not the
// rendered text (substituted content may legitimately contain $-words).

export class PromptError extends Error {}

const PATTERN = /\$(?:(\$)|([_a-zA-Z][_a-zA-Z0-9]*)|\{([_a-zA-Z][_a-zA-Z0-9]*)\})/g;

function identifiers(text) {
  const ids = new Set();
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    checkInvalid(text, last, m.index);
    last = m.index + m[0].length;
    const name = m[2] || m[3];
    if (name) ids.add(name);
  }
  checkInvalid(text, last, text.length);
  return ids;
}

// A '$' not consumed by the pattern is Python's "invalid" group.
function checkInvalid(text, from, to) {
  const i = text.slice(from, to).indexOf("$");
  if (i !== -1) {
    const at = from + i;
    throw new PromptError(`malformed '$' placeholder in template near: ${JSON.stringify(text.slice(at, at + 30))}`);
  }
}

export function render(templateText, variables) {
  const ids = identifiers(templateText);
  const provided = new Set(Object.keys(variables));
  const missing = [...ids].filter((k) => !provided.has(k)).sort();
  if (missing.length) throw new PromptError(`prompt template references ${JSON.stringify(missing.map((m) => "$" + m))} but no value was provided`);
  const unused = [...provided].filter((k) => !ids.has(k)).sort();
  const warnings = unused.length ? [`⚠️ prompt variables provided but not used by template: ${JSON.stringify(unused)}`] : [];
  const out = templateText.replace(PATTERN, (whole, dollar, named, braced) => (dollar ? "$" : String(variables[named || braced])));
  return { text: out, warnings };
}
