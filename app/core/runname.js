// Output naming — pure part of scripts/lib/runfolder.py, ported for the app.
// Head convention (FC, 2026-08-26): the canonical name always holds the MOST
// RECENT version; before overwriting, the existing file is archived into an
// old/ subfolder beside it, renamed with its own modification timestamp before
// the final extension. metadata.yaml is a log and accumulates in place.
// Teacher-facing files sit beside the audio; plumbing goes to system/.
// The GIFT role carries a final .md (FC, 2026-08-27): pure GIFT content, but
// Android editors and Drive can open it; Moodle import ignores the extension.

export const PLUMBING_ROLES = new Set(["metadata.yaml", "questions.json", "questions.partial.json"]);
export const ROLE_GIFT = "questions.gift.md";

export function planOutputs(sourceName) {
  // sourceName = the audio file name, or an existing X.transcript.md for generate-only.
  let base = sourceName.replace(/\.[^.]*$/, "");
  if (base.endsWith(".transcript")) base = base.slice(0, -".transcript".length);
  return base;
}

export function roleFile(stem, role) {
  return { subfolder: PLUMBING_ROLES.has(role) ? "system" : null, name: `${stem}.${role}` };
}

// Archive name: split on the LAST dot, stamp with the file's own mtime.
export function archiveName(name, mtime, withMicros = false) {
  const dot = name.lastIndexOf(".");
  const head = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  let stamp = `${mtime.getFullYear()}-${p(mtime.getMonth() + 1)}-${p(mtime.getDate())} ${p(mtime.getHours())}-${p(mtime.getMinutes())}-${p(mtime.getSeconds())}`;
  if (withMicros) stamp += `.${p(mtime.getMilliseconds(), 3)}000`;
  return `${head}-${stamp}${ext}`;
}

// Transcript YAML front matter, mirroring runfolder.write_transcript.
export function transcriptDocument(cfg, text, usage, yamlLib, todayIso) {
  const sessionTxt = cfg.sessionId !== null && cfg.sessionId !== undefined ? ` S${cfg.sessionId}` : "";
  const header = {
    title: `${cfg.courseCode}${sessionTxt} transcript`,
    created: todayIso,
    modified: todayIso,
    intent: "clean lecture transcript, source for question generation",
    tags: ["tsct", "transcript", cfg.courseCode.toLowerCase()],
    course_name: cfg.courseName,
    session_date: cfg.sessionDate,
    audio_file: cfg.audioFileName || null,
    model: usage.model,
    dominant_language: cfg.dominantLanguage,
    prompt_tokens: usage.promptTokens,
    output_tokens: usage.outputTokens,
  };
  const front = yamlLib.dump(header, { sortKeys: false });
  return `---\n${front}---\n\n${text.trim()}\n`;
}

const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/;

export function stripFrontMatter(text) {
  return text.replace(FRONT_MATTER, "").trim();
}

// Run-log naming (Tracker to-do, FC 2026-08-26): per phase, a smart dump in
// system/: `X.<phase>.log YYYY-MM-DD HH-MM.md`.
export function runLogName(stem, phase, when) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}-${p(when.getMinutes())}`;
  return `${stem}.${phase}.log ${stamp}.md`;
}
