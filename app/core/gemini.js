// Gemini REST client — JS port of scripts/lib/gemini_client.py, fetch-based.
// App decision (FC, 2026-08-27): audio ALWAYS goes through the Files API
// resumable upload — production recordings are ~2 h, and one code path beats
// two (inline transport eliminated even for testing). Context files (small
// pdf/md/txt) stay inline. The API key is passed in and never logged.

export const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files";
export const MAX_INLINE_SOURCE_BYTES = 14 * 1024 * 1024;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS = [5, 20, 60];

export const MIME_TYPES = {
  ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".flac": "audio/flac", ".aiff": "audio/aiff", ".aif": "audio/aiff",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/plain",
};

// Enforced server-side via responseSchema; re-validated client-side in questions.js.
export const QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["mcq", "truefalse"] },
          name: { type: "string" },
          stem: { type: "string" },
          correct: { type: "string" },
          distractors: { type: "array", items: { type: "string" } },
          answer: { type: "boolean" },
          feedback: { type: "string" },
        },
        required: ["type", "name", "stem"],
      },
    },
  },
  required: ["questions"],
};

export class ApiError extends Error {}

export class TruncationError extends ApiError {
  constructor(message, partialText) {
    super(message);
    this.partialText = partialText;
  }
}

export function mimeFor(name) {
  const dot = name.lastIndexOf(".");
  const mime = MIME_TYPES[dot === -1 ? "" : name.slice(dot).toLowerCase()];
  if (!mime) throw new ApiError(`unsupported file type for ${name} (known: ${Object.keys(MIME_TYPES).sort().join(", ")})`);
  return mime;
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// bytes: ArrayBuffer/Uint8Array. Two calls (start -> upload+finalize), then
// poll until ACTIVE. Returns the file info dict ('uri' goes in file_data).
export async function uploadFile(name, bytes, apiKey, log = () => {}) {
  const mime = mimeFor(name);
  const size = bytes.byteLength ?? bytes.length;
  const start = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": mime,
    },
    body: JSON.stringify({ file: { display_name: name } }),
  });
  if (!start.ok) throw new ApiError(`Files API start HTTP ${start.status}: ${(await start.text()).slice(0, 400)}`);
  const uploadUrl = start.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) throw new ApiError("Files API: no upload URL returned");
  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0" },
    body: bytes,
  });
  if (!up.ok) throw new ApiError(`Files API upload HTTP ${up.status}: ${(await up.text()).slice(0, 400)}`);
  let info = (await up.json()).file;
  for (let i = 0; i < 60; i++) {
    if (info.state === "ACTIVE") return info;
    await sleep(2);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${info.name}`, { headers: { "x-goog-api-key": apiKey } });
    if (!r.ok) throw new ApiError(`Files API poll HTTP ${r.status}`);
    info = await r.json();
    log(`… upload processing (${info.state})`);
  }
  throw new ApiError(`Files API: uploaded file never became ACTIVE (state: ${info.state})`);
}

function generationConfig(settings, jsonSchema) {
  const cfg = { maxOutputTokens: settings.maxOutputTokens, temperature: settings.temperature };
  if (settings.thinkingLevel !== null && settings.thinkingLevel !== undefined) cfg.thinkingConfig = { thinkingLevel: settings.thinkingLevel };
  else if (settings.thinkingBudget !== null && settings.thinkingBudget !== undefined) cfg.thinkingConfig = { thinkingBudget: settings.thinkingBudget };
  if (jsonSchema) {
    cfg.responseMimeType = "application/json";
    cfg.responseSchema = jsonSchema;
  }
  return cfg;
}

async function post(model, body, apiKey, { fastFail = false, log = () => {} } = {}) {
  const url = `${API_BASE}/${model}:generateContent`;
  const delays = fastFail ? [] : RETRY_DELAYS;
  let lastError = "no attempt made";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      });
      if (r.ok) return await r.json();
      const detail = (await r.text()).slice(0, 800);
      lastError = `API HTTP ${r.status}: ${detail}`;
      if (!RETRY_STATUS.has(r.status)) throw new ApiError(lastError);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      lastError = `network error: ${e.message}`;
    }
    if (attempt < delays.length) {
      log(`retrying in ${delays[attempt]}s (${lastError.slice(0, 120)})`);
      await sleep(delays[attempt]);
    }
  }
  throw new ApiError(`giving up after ${delays.length + 1} attempts — ${lastError}`);
}

function extract(data) {
  const candidates = data.candidates;
  if (!candidates || !candidates.length) {
    const block = (data.promptFeedback || {}).blockReason || "unknown";
    throw new ApiError(`no candidates in response (blockReason: ${block})`);
  }
  const candidate = candidates[0];
  const finish = candidate.finishReason || "UNKNOWN";
  const parts = (candidate.content || {}).parts || [];
  const text = parts.map((p) => p.text || "").join("");
  if (!text) throw new ApiError(`response contains no text (finishReason: ${finish}, message: ${candidate.finishMessage || "—"})`);
  return { text, finish };
}

export async function callModel(model, parts, settings, apiKey, { callName, jsonSchema = null, fastFail = false, log = () => {} }) {
  const body = { contents: [{ role: "user", parts }], generationConfig: generationConfig(settings, jsonSchema) };
  const start = Date.now();
  const data = await post(model, body, apiKey, { fastFail, log });
  const { text, finish } = extract(data);
  const um = data.usageMetadata || {};
  const usage = {
    call: callName,
    model,
    promptTokens: Math.trunc(um.promptTokenCount || 0),
    outputTokens: Math.trunc(um.candidatesTokenCount || 0),
    thoughtsTokens: Math.trunc(um.thoughtsTokenCount || 0),
    totalTokens: Math.trunc(um.totalTokenCount || 0),
    wallSeconds: (Date.now() - start) / 1000,
    resolvedModel: String(data.modelVersion || ""),
  };
  if (finish === "MAX_TOKENS")
    throw new TruncationError(
      `${callName} hit max_output_tokens (${settings.maxOutputTokens}) — output truncated (raise the limit, or the session needs the deferred chunking option)`,
      text
    );
  if (finish !== "STOP" && finish !== "UNKNOWN") log(`⚠️ ${callName}: finishReason=${finish}`);
  return { text, usage, request: { model, body: { ...body, contents: "(see prompt/context below)" }, generationConfig: body.generationConfig }, raw: data };
}

export function inlinePart(name, bytes) {
  return { inline_data: { mime_type: mimeFor(name), data: base64FromBytes(bytes) } };
}

export function base64FromBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Chunked to avoid call-stack limits on multi-MB files.
  let binary = "";
  for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Canary (pre-class assurance): one tiny fast-fail round-trip per model.
export async function canary(models, apiKey) {
  const settings = { maxOutputTokens: 3000, temperature: 0.0, thinkingBudget: null, thinkingLevel: "low" };
  const results = [];
  for (const model of [...new Set(models)]) {
    const start = Date.now();
    try {
      const { usage } = await callModel(model, [{ text: "Reply with the single word: pong" }], settings, apiKey, { callName: "canary", fastFail: true });
      results.push({ model, ok: true, resolvedModel: usage.resolvedModel, seconds: (Date.now() - start) / 1000 });
    } catch (e) {
      results.push({ model, ok: false, error: String(e.message) });
    }
  }
  return results;
}
