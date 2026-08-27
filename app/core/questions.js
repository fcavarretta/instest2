// Question model — JS port of scripts/lib/questions.py.
// Re-validates the JSON payload from the generation call: schema enforcement
// does not survive truncation and does not check semantic constraints.
// Whitespace is normalized on entry (GIFT forbids raw newlines in a field).

export class QuestionError extends Error {}

export const TYPES = new Set(["mcq", "truefalse"]);
export const NAME_MAX = 40;
export const EXPECTED_OPTIONS = 4;

const norm = (v) => String(v).replace(/\s+/g, " ").trim();

function parseOne(item, n, warn) {
  const where = `question #${n}`;
  if (item === null || typeof item !== "object" || Array.isArray(item)) throw new QuestionError(`${where}: expected an object`);

  const qtype = norm(item.type ?? "").toLowerCase();
  if (!TYPES.has(qtype)) throw new QuestionError(`${where}: type must be one of ${JSON.stringify([...TYPES].sort())}, got '${qtype}'`);

  const stem = norm(item.stem ?? "");
  if (!stem) throw new QuestionError(`${where}: empty stem`);

  let name = norm(item.name ?? "") || `q${n}`;
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).trimEnd();

  const feedback = norm(item.feedback ?? "");

  let options = null, correctIndex = null, answer = null;

  if (qtype === "mcq") {
    // Primary format (2026-08-26): "correct" as TEXT + "distractors" — Gemini 3
    // reliably states the answer but omits bookkeeping like correct_index.
    if (item.correct !== null && item.correct !== undefined) {
      const correct = norm(item.correct);
      const rawD = item.distractors;
      if (!correct || !Array.isArray(rawD) || !rawD.length) throw new QuestionError(`${where}: mcq needs 'correct' (text) and a 'distractors' list`);
      options = [correct, ...rawD.map(norm)];
      correctIndex = 0;
    } else {
      const rawOptions = item.options;
      if (!Array.isArray(rawOptions) || rawOptions.length < 2) throw new QuestionError(`${where}: mcq needs 'correct'+'distractors' (or legacy 'options'+'correct_index')`);
      options = rawOptions.map(norm);
      const ci = item.correct_index;
      if (!Number.isInteger(ci) || typeof ci === "boolean" || ci < 0 || ci >= options.length)
        throw new QuestionError(`${where}: correct_index must be an integer in [0, ${options.length - 1}], got ${JSON.stringify(ci)}`);
      correctIndex = ci;
    }
    if (options.some((o) => !o)) throw new QuestionError(`${where}: empty option`);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new QuestionError(`${where}: duplicate options`);
    if (options.length !== EXPECTED_OPTIONS) warn(`⚠️ ${where}: ${options.length} options (expected ${EXPECTED_OPTIONS}) — kept`);
  } else {
    const rawAnswer = item.answer;
    if (typeof rawAnswer !== "boolean") throw new QuestionError(`${where}: truefalse needs a boolean 'answer', got ${JSON.stringify(rawAnswer)}`);
    answer = rawAnswer;
  }

  return { qtype, name, stem, options, correctIndex, answer, feedback };
}

export function parseQuestions(raw, warn = () => {}) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new QuestionError(`model output is not valid JSON (${e.message}) — if the raw file ends mid-structure, the output was probably truncated (check finishReason / max_output_tokens)`);
  }
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.questions)) throw new QuestionError("model output must be an object with a 'questions' list");
  const items = payload.questions;
  if (!items.length) throw new QuestionError("model returned an empty 'questions' list");
  // One malformed question must not kill the batch. Skip it LOUDLY; fail only
  // if nothing survives.
  const questions = [], errors = [];
  items.forEach((item, i) => {
    try {
      questions.push(parseOne(item, i + 1, warn));
    } catch (e) {
      if (!(e instanceof QuestionError)) throw e;
      errors.push(e.message);
      warn(`⚠️ skipped invalid ${e.message}`);
    }
  });
  if (!questions.length) throw new QuestionError(`all ${items.length} questions invalid — first error: ${errors[0]}`);
  if (errors.length) warn(`⚠️ ${errors.length} of ${items.length} questions skipped — review coverage`);
  return questions;
}

export function checkCount(questions, expectedTotal, target, warn = () => {}) {
  const got = questions.length;
  if (got < target) warn(`⚠️ only ${got} questions for a target of ${target} (asked ${expectedTotal}) — review coverage`);
  else if (got < expectedTotal) warn(`⚠️ ${got} questions returned, ${expectedTotal} asked (target ${target} still met)`);
}
