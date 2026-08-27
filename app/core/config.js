// Configuration cascade: system.yaml -> course.yaml -> session.yaml.
// JS port of scripts/lib/config.py (reference implementation & test oracle).
// Merge rule: dicts merge recursively, scalars and lists REPLACE (later layer
// wins). Single documented exception: context_files, where course-level and
// session-level lists are APPENDED. Paths here are Drive-relative names; the
// drive layer resolves them against each YAML's own directory.

export const LANG_NAMES = { fr: "French", en: "English" };

export const KNOWN_SYSTEM_KEYS = new Set(["models", "reserve_percent", "transcription", "generation", "output_root", "prompts", "gift", "pricing", "question_count"]);
export const KNOWN_COURSE_KEYS = new Set(["course_code", "course_name", "dominant_language", "question_language", "course_prompt", "context_files", "schedule", "question_count"]);
export const KNOWN_SESSION_KEYS = new Set(["session_id", "session_date", "audio_file", "session_prompt", "question_count", "question_language", "context_files"]);

export class ConfigError extends Error {}

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function deepMerge(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key in merged && isDict(merged[key]) && isDict(value)) merged[key] = deepMerge(merged[key], value);
    else merged[key] = value;
  }
  return merged;
}

function warnUnknown(data, known, path, warn) {
  for (const key of Object.keys(data)) if (!known.has(key)) warn(`⚠️ ${path}: unknown key '${key}' (typo?)`);
}

function require_(data, key, path) {
  if (!(key in data) || data[key] === null || data[key] === undefined) throw new ConfigError(`${path}: missing required key '${key}'`);
  return data[key];
}

function language(value, key, path) {
  const lang = String(value).toLowerCase();
  if (!(lang in LANG_NAMES)) throw new ConfigError(`${path}: '${key}' must be one of ${JSON.stringify(Object.keys(LANG_NAMES).sort())}, got '${value}'`);
  return lang;
}

function callSettings(data, section, path) {
  const sub = data[section];
  if (!isDict(sub)) throw new ConfigError(`${path}: missing section '${section}'`);
  const budget = sub.thinking_budget ?? null;
  const level = sub.thinking_level ?? null;
  if (budget !== null && level !== null) throw new ConfigError(`${path}: '${section}' sets both thinking_budget and thinking_level — the API rejects that; keep one`);
  if (level !== null && !["low", "high"].includes(String(level))) throw new ConfigError(`${path}: '${section}.thinking_level' must be 'low' or 'high', got '${level}'`);
  return {
    maxOutputTokens: Math.trunc(Number(require_(sub, "max_output_tokens", path))),
    temperature: Number(require_(sub, "temperature", path)),
    thinkingBudget: budget === null ? null : Math.trunc(Number(budget)),
    thinkingLevel: level === null ? null : String(level),
  };
}

// context_files stay raw specs {base, item} — the environment (Drive layer or
// node test shim) expands folders/globs, mirroring Python's _context_files.
function contextSpecs(data, path, base) {
  const raw = data.context_files ?? [];
  if (!Array.isArray(raw)) throw new ConfigError(`${path}: 'context_files' must be a list`);
  return raw.map((item) => ({ base, item: String(item), from: path }));
}

export function parseYamlMapping(text, path, yamlLib) {
  let data;
  try {
    data = yamlLib.load(text);
  } catch (e) {
    throw new ConfigError(`${path}: invalid YAML — ${e.message}`);
  }
  if (data === null || data === undefined) data = {};
  if (!isDict(data)) throw new ConfigError(`${path}: top level must be a mapping`);
  return data;
}

// texts: {system, course, session}; paths: display names for error messages;
// bases: directory handles/paths the environment uses to resolve relative names.
export function loadConfig({ texts, paths, bases = {}, yamlLib, overrides = {}, warn = () => {}, today = null }) {
  const system = parseYamlMapping(texts.system, paths.system, yamlLib);
  const course = parseYamlMapping(texts.course, paths.course, yamlLib);
  const session = parseYamlMapping(texts.session, paths.session, yamlLib);
  warnUnknown(system, KNOWN_SYSTEM_KEYS, paths.system, warn);
  warnUnknown(course, KNOWN_COURSE_KEYS, paths.course, warn);
  warnUnknown(session, KNOWN_SESSION_KEYS, paths.session, warn);

  const contextFiles = [...contextSpecs(course, paths.course, bases.course), ...contextSpecs(session, paths.session, bases.session)];
  const courseClean = Object.fromEntries(Object.entries(course).filter(([k]) => k !== "context_files"));
  const sessionClean = Object.fromEntries(Object.entries(session).filter(([k]) => k !== "context_files"));

  const merged = deepMerge(deepMerge(system, courseClean), sessionClean);

  const models = merged.models;
  if (!isDict(models)) throw new ConfigError(`${paths.system}: missing section 'models'`);
  const prompts = merged.prompts;
  if (!isDict(prompts)) throw new ConfigError(`${paths.system}: missing section 'prompts'`);

  if (merged.question_count === null || merged.question_count === undefined)
    throw new ConfigError(`question_count is not set at any layer — set it once in ${paths.system}, ${paths.course}, or ${paths.session} (lowest level wins)`);
  const questionCount = Math.trunc(Number(merged.question_count));
  const reservePercent = Math.trunc(Number(require_(merged, "reserve_percent", paths.system)));
  if (questionCount <= 0 || reservePercent < 0) throw new ConfigError(`${paths.session}: question_count must be > 0 and reserve_percent >= 0`);

  let sessionId = merged.session_id ?? null;
  if (sessionId !== null) {
    const n = Number(sessionId);
    sessionId = Number.isInteger(n) && String(sessionId).trim() !== "" ? n : String(sessionId);
  }

  const todayIso = today || new Date().toISOString().slice(0, 10);
  const sessionDateRaw = merged.session_date;
  const sessionDate = sessionDateRaw ? isoDate(sessionDateRaw) : todayIso;

  return {
    modelTranscription: overrides.modelTranscription || String(require_(models, "transcription", paths.system)),
    modelGeneration: overrides.modelGeneration || String(require_(models, "generation", paths.system)),
    transcription: callSettings(merged, "transcription", paths.system),
    generation: callSettings(merged, "generation", paths.system),
    courseCode: String(require_(merged, "course_code", paths.course)),
    courseName: String(require_(merged, "course_name", paths.course)),
    dominantLanguage: language(require_(merged, "dominant_language", paths.course), "dominant_language", paths.course),
    questionLanguage: language(require_(merged, "question_language", paths.course), "question_language", paths.course),
    coursePrompt: String(merged.course_prompt || ""),
    sessionId,
    sessionDate,
    sessionPrompt: String(merged.session_prompt || ""),
    audioFile: merged.audio_file ? String(merged.audio_file) : null,
    contextFiles,
    questionCount,
    reservePercent,
    questionCountTotal: Math.ceil(questionCount * (1 + reservePercent / 100)),
    outputRoot: merged.output_root ? String(merged.output_root) : null,
    promptTranscription: String(require_(prompts, "transcription", paths.system)),
    promptGeneration: String(require_(prompts, "generation", paths.system)),
    giftCategoryHeader: Boolean((merged.gift ?? {}).category_header ?? true),
    pricing: merged.pricing || {},
  };
}

// yaml may parse a bare date as a Date object; normalize to YYYY-MM-DD like Python's str().
function isoDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function otherLanguage(lang) {
  return lang === "fr" ? "en" : "fr";
}

// Context eligibility, mirroring Python's _eligible_context / _OUTPUT_MARKERS.
export const CONTEXT_EXTENSIONS = new Set([".pdf", ".txt", ".md"]);
const OUTPUT_MARKERS = [".transcript", ".questions", ".metadata", ".log"];

export function eligibleContext(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return CONTEXT_EXTENSIONS.has(ext) && !OUTPUT_MARKERS.some((m) => name.includes(m));
}
