// The app's pipeline orchestration — the JS equivalent of run_qcm.py's main(),
// wired to Drive instead of a filesystem. The functional surface is the Colab
// notebook's, exactly: same parameters, same two actions (Transcribe /
// Generate), same output conventions (head, old/, system/, metadata
// accumulation), plus the per-phase run logs (Tracker to-do, 2026-08-26).

import { loadConfig, otherLanguage, LANG_NAMES, eligibleContext, ConfigError } from "./core/config.js";
import { render } from "./core/prompts.js";
import { parseQuestions, checkCount } from "./core/questions.js";
import { renderGift } from "./core/gift.js";
import { usageMetadata, consoleSummary } from "./core/costs.js";
import { planOutputs, roleFile, transcriptDocument, stripFrontMatter, runLogName, ROLE_GIFT } from "./core/runname.js";
import * as gemini from "./core/gemini.js";
import * as drive from "./drive.js";

const yamlLib = window.jsyaml;

// ---- resources: bundled defaults + element-wise Drive overrides ----------
// (FC-approved 2026-08-27) The app ships a default resource set served from
// the repo itself (GitHub Pages serves ../resources/). If the active Drive
// directory contains a resources/ folder, any element present there overrides
// the corresponding default, element-wise.
const RESOURCE_ELEMENTS = ["system.yaml", "prompts/transcription.txt", "prompts/generation_system.txt"];

async function fetchDefault(element) {
  const r = await fetch(`../resources/${element}`);
  if (!r.ok) throw new ConfigError(`bundled resource missing: resources/${element} (HTTP ${r.status})`);
  return r.text();
}

export async function loadResources(dirId, log = () => {}) {
  const texts = {};
  const origins = {};
  for (const element of RESOURCE_ELEMENTS) {
    texts[element] = await fetchDefault(element);
    origins[element] = "bundled default";
  }
  const overrideFolder = await drive.findChild(dirId, "resources", { folder: true });
  if (overrideFolder) {
    for (const element of RESOURCE_ELEMENTS) {
      const meta = await drive.resolvePath(overrideFolder.id, element);
      if (meta && meta.mimeType !== drive.FOLDER_MIME) {
        texts[element] = await drive.downloadText(meta.id);
        origins[element] = "Drive override";
        log(`🗂 resources/${element}: Drive override active`);
      }
    }
  }
  return { texts, origins };
}

// Map the system.yaml prompts entries (relative paths like
// prompts/transcription.txt) onto the resource set's element names.
function promptElement(configuredPath) {
  const normalized = configuredPath.replace(/^\.\//, "");
  if (RESOURCE_ELEMENTS.includes(normalized)) return normalized;
  const base = normalized.split("/").pop();
  const match = RESOURCE_ELEMENTS.find((e) => e.split("/").pop() === base);
  if (!match) throw new ConfigError(`prompt '${configuredPath}' is not part of the app resource set (${RESOURCE_ELEMENTS.join(", ")})`);
  return match;
}

// ---- config --------------------------------------------------------------
export async function buildConfig({ dirId, courseMeta, sessionMeta, resources, warn }) {
  const cfg = loadConfig({
    texts: {
      system: resources.texts["system.yaml"],
      course: await drive.downloadText(courseMeta.id),
      session: await drive.downloadText(sessionMeta.id),
    },
    paths: { system: "system.yaml", course: courseMeta.name, session: sessionMeta.name },
    bases: { course: courseMeta.parents?.[0] || dirId, session: sessionMeta.parents?.[0] || dirId },
    yamlLib,
    warn,
  });
  cfg.promptTexts = {
    transcription: resources.texts[promptElement(cfg.promptTranscription)],
    generation: resources.texts[promptElement(cfg.promptGeneration)],
  };
  if (cfg.outputRoot) warn("⚠️ output_root is set but the app always writes beside the audio file — ignored");
  return cfg;
}

// ---- context files -------------------------------------------------------
// Port of config._context_files, resolving against Drive. Each spec's base is
// the Drive folder of the YAML that declared it; folders expand to their
// eligible files; globs match within the named parent folder.
export async function expandContext(specs, warn) {
  const out = [];
  for (const { base, item, from } of specs) {
    if (item.includes("*") || item.includes("?")) {
      const parts = item.split("/");
      const pattern = parts.pop();
      const parent = parts.length ? await drive.resolvePath(base, parts.join("/")) : { id: base, mimeType: drive.FOLDER_MIME };
      const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      const matches = parent ? (await drive.listChildren(parent.id)).filter((f) => f.mimeType !== drive.FOLDER_MIME && regex.test(f.name) && eligibleContext(f.name)) : [];
      if (!matches.length) warn(`⚠️ ${from}: context pattern '${item}' matched no eligible files (outputs excluded)`);
      out.push(...matches.sort((a, b) => a.name.localeCompare(b.name)));
    } else {
      const meta = await drive.resolvePath(base, item);
      if (!meta) throw new gemini.ApiError(`context file not found in Drive: ${item} (from ${from})`);
      if (meta.mimeType === drive.FOLDER_MIME) {
        const expanded = (await drive.listChildren(meta.id)).filter((f) => f.mimeType !== drive.FOLDER_MIME && eligibleContext(f.name)).sort((a, b) => a.name.localeCompare(b.name));
        if (!expanded.length) warn(`⚠️ ${from}: context folder '${item}' contains no eligible files (outputs excluded)`);
        out.push(...expanded);
      } else {
        out.push(meta); // explicit single file: taken as-is, even an output, deliberately
      }
    }
  }
  return out;
}

// ---- run logs (Tracker to-do, FC 2026-08-26) -----------------------------
// Per phase, a smart dump in system/: effective config, exact request (model,
// generationConfig, full prompt, attached parts), full raw LLM response,
// usage/cost, timings. For inspection/forensics.
async function writeRunLog({ systemDirId, stem, phase, cfg, prompt, parts, result, usages, pricing }) {
  const name = runLogName(stem, phase, new Date());
  const publicCfg = { ...cfg };
  delete publicCfg.promptTexts; // huge and duplicated in the prompt section below
  const partsDesc = parts.map((p) =>
    p.text ? { text: `(prompt, ${p.text.length} chars — see below)` } : p.file_data ? { file_data: p.file_data } : { inline_data: { mime_type: p.inline_data.mime_type, bytes: "(base64 elided)" } }
  );
  const md = [
    `# ${stem} — ${phase} run log`,
    ``,
    `Generated by the TSCT app, ${new Date().toISOString()}.`,
    ``,
    `## Effective config`,
    "```json\n" + JSON.stringify(publicCfg, null, 2) + "\n```",
    `## Request`,
    "```json\n" + JSON.stringify({ model: result.request.model, generationConfig: result.request.generationConfig, parts: partsDesc }, null, 2) + "\n```",
    `## Full prompt`,
    "````text\n" + prompt + "\n````",
    `## Raw response`,
    "```json\n" + JSON.stringify(result.raw, null, 2) + "\n```",
    `## Usage / cost`,
    "```\n" + consoleSummary(usages, pricing) + "\n```",
    ``,
  ].join("\n\n");
  await drive.createFile(systemDirId, name, md);
  return name;
}

// ---- phases --------------------------------------------------------------

export async function runTranscribe({ dirId, cfg, audioMeta, apiKey, log }) {
  const stem = planOutputs(audioMeta.name);
  const transcriptionVars = {
    course_name: cfg.courseName,
    session_date: cfg.sessionDate,
    dominant_language: LANG_NAMES[cfg.dominantLanguage],
    other_language: LANG_NAMES[otherLanguage(cfg.dominantLanguage)],
  };
  const { text: prompt, warnings } = render(cfg.promptTexts.transcription, transcriptionVars);
  warnings.forEach(log);

  log(`⬇️ downloading ${audioMeta.name} from Drive (${(Number(audioMeta.size) / 1e6).toFixed(1)} MB)…`);
  const bytes = await drive.downloadBytes(audioMeta.id);
  log(`📤 uploading to Gemini (Files API — Google keeps it 48 h)…`);
  const info = await gemini.uploadFile(audioMeta.name, bytes, apiKey, log);
  log(`   uploaded ✓`);
  const parts = [{ file_data: { mime_type: gemini.mimeFor(audioMeta.name), file_uri: info.uri } }, { text: prompt }];

  log(`🎙️ transcribing with ${cfg.modelTranscription}…`);
  const outDirId = audioMeta.parents?.[0] || dirId;
  const systemDirId = await drive.ensureFolder(outDirId, "system");
  let result;
  try {
    result = await gemini.callModel(cfg.modelTranscription, parts, cfg.transcription, apiKey, { callName: "transcription", log });
  } catch (e) {
    if (e instanceof gemini.TruncationError) {
      const partial = roleFile(stem, "transcript.partial.md");
      await drive.writeWithHead(outDirId, partial.name, e.partialText, "text/plain", log);
      throw new gemini.ApiError(`⛔ TRANSCRIPT TRUNCATED — INCOMPLETE, DO NOT USE AS-IS. ${e.message} — partial saved to ${partial.name}`);
    }
    throw e;
  }
  const usages = [result.usage];
  cfg.audioFileName = audioMeta.name;
  const doc = transcriptDocument(cfg, result.text, result.usage, yamlLib, new Date().toISOString().slice(0, 10));
  const transcriptFile = roleFile(stem, "transcript.md");
  await drive.writeWithHead(outDirId, transcriptFile.name, doc, "text/plain", log);
  log(`📄 Transcript: ${transcriptFile.name} (${result.text.split(/\s+/).length} words)`);

  const metaFile = roleFile(stem, "metadata.yaml");
  await drive.writeMetadata(systemDirId, metaFile.name, {
    course_code: cfg.courseCode,
    session_id: cfg.sessionId,
    session_date: cfg.sessionDate,
    audio_file: audioMeta.name,
    ...usageMetadata(usages, cfg.pricing),
  }, yamlLib);
  const logName = await writeRunLog({ systemDirId, stem, phase: "transcribe", cfg, prompt, parts, result, usages, pricing: cfg.pricing });
  log(`🧾 run log: system/${logName}`);
  log(consoleSummary(usages, cfg.pricing));
  return { stem, outDirId };
}

export async function runGenerate({ dirId, cfg, audioMeta, apiKey, log }) {
  const stem = planOutputs(audioMeta.name);
  const outDirId = audioMeta.parents?.[0] || dirId;
  // STRICT head convention (FC, 2026-08-26 — no fallback, deliberately): the
  // transcript must be <audio stem>.transcript.md beside the audio.
  const transcriptName = `${stem}.transcript.md`;
  const transcriptMeta = await drive.findChild(outDirId, transcriptName);
  if (!transcriptMeta) {
    const others = (await drive.listChildren(outDirId)).map((f) => f.name).filter((n) => n.endsWith(".transcript.md"));
    throw new gemini.ApiError(`${transcriptName} not found (transcripts present: ${others.join(", ") || "none"}) — run Transcribe first, or rename/move the right transcript beside the audio`);
  }
  const transcript = stripFrontMatter(await drive.downloadText(transcriptMeta.id));
  log(`📄 Reusing transcript: ${transcriptName} (${transcript.split(/\s+/).length} words)`);

  const generationVars = {
    course_name: cfg.courseName,
    question_count_total: cfg.questionCountTotal,
    question_language: LANG_NAMES[cfg.questionLanguage],
    course_prompt: cfg.coursePrompt || "(none)",
    session_prompt: cfg.sessionPrompt || "(none)",
    transcript,
  };
  const { text: prompt, warnings } = render(cfg.promptTexts.generation, generationVars);
  warnings.forEach(log);

  const contexts = await expandContext(cfg.contextFiles, log);
  const parts = [];
  let total = 0;
  for (const c of contexts) {
    total += Number(c.size || 0);
    log(`📎 context: ${c.name}`);
    parts.push(gemini.inlinePart(c.name, await drive.downloadBytes(c.id)));
  }
  if (total > gemini.MAX_INLINE_SOURCE_BYTES) throw new gemini.ApiError(`context files total ${(total / 1e6).toFixed(0)} MB > inline cap — trim or compress them`);
  parts.push({ text: prompt });

  log(`❓ generating ${cfg.questionCountTotal} questions with ${cfg.modelGeneration}…`);
  const systemDirId = await drive.ensureFolder(outDirId, "system");
  let result;
  try {
    result = await gemini.callModel(cfg.modelGeneration, parts, cfg.generation, apiKey, { callName: "generation", jsonSchema: gemini.QUESTIONS_SCHEMA, log });
  } catch (e) {
    if (e instanceof gemini.TruncationError) {
      const partial = roleFile(stem, "questions.partial.json");
      await drive.writeWithHead(systemDirId, partial.name, e.partialText, "application/json", log);
      throw new gemini.ApiError(`⛔ QUESTIONS TRUNCATED — INCOMPLETE, DO NOT USE. ${e.message} — partial saved to system/${partial.name}`);
    }
    throw e;
  }
  const usages = [result.usage];
  await drive.writeWithHead(systemDirId, roleFile(stem, "questions.json").name, result.text, "application/json", log);
  const parsed = parseQuestions(result.text, log);
  checkCount(parsed, cfg.questionCountTotal, cfg.questionCount, log);
  const giftText = renderGift(parsed, {
    courseCode: cfg.courseCode,
    sessionId: cfg.sessionId,
    sessionDate: cfg.sessionDate,
    model: cfg.modelGeneration,
    categoryHeader: cfg.giftCategoryHeader,
  });
  const giftFile = roleFile(stem, ROLE_GIFT);
  await drive.writeWithHead(outDirId, giftFile.name, giftText, "text/markdown", log);
  log(`✅ ${parsed.length} questions → ${giftFile.name}`);

  await drive.writeMetadata(systemDirId, roleFile(stem, "metadata.yaml").name, {
    course_code: cfg.courseCode,
    session_id: cfg.sessionId,
    session_date: cfg.sessionDate,
    audio_file: audioMeta.name,
    ...usageMetadata(usages, cfg.pricing),
  }, yamlLib);
  const logName = await writeRunLog({ systemDirId, stem, phase: "generate", cfg, prompt, parts, result, usages, pricing: cfg.pricing });
  log(`🧾 run log: system/${logName}`);
  log(consoleSummary(usages, cfg.pricing));
  return { stem, questions: parsed.length };
}
