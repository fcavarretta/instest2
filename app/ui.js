// UI wiring for the TSCT QCM app. The invariant this screen serves (FC):
// parametrize once; thereafter open the app → point at the recorded file →
// Transcribe → Generate. Nothing else, ever.

import * as drive from "./drive.js";
import * as gemini from "./core/gemini.js";
import { parseYamlMapping } from "./core/config.js";
import { loadResources, buildConfig, runTranscribe, runGenerate } from "./pipeline.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "tsct-app-settings";
const AUDIO_EXT = [".m4a", ".mp3", ".wav", ".aac", ".ogg", ".flac", ".aiff", ".aif"];
const TEXT_EXT = [".md", ".yaml", ".yml", ".txt", ".gift", ".json"];

let settings = load();
let dirId = null;
let listing = [];
let systemListing = [];
let editorFile = null;

function load() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}
function save() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---- log & banner --------------------------------------------------------
function log(msg) {
  const el = $("log");
  el.textContent += (el.textContent ? "\n" : "") + msg;
  el.scrollTop = el.scrollHeight;
}
function clearLog() {
  $("log").textContent = "";
}
function banner(kind, msg) {
  const el = $("banner");
  el.className = "banner " + kind;
  el.textContent = msg;
}
function clearBanner() {
  $("banner").className = "banner";
}

// ---- tabs ----------------------------------------------------------------
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
    for (const tab of ["run", "files", "settings"]) $("tab-" + tab).classList.toggle("hidden", b.dataset.tab !== tab);
    if (b.dataset.tab === "files") refreshFiles().catch((e) => banner("error", e.message));
  })
);

// ---- settings ------------------------------------------------------------
$("clientId").value = settings.clientId || "";
$("geminiKey").value = settings.geminiKey || "";
$("dirPath").value = settings.dirPath || "";

$("saveSettingsBtn").addEventListener("click", async () => {
  clearBanner();
  settings.clientId = $("clientId").value.trim();
  settings.geminiKey = $("geminiKey").value.trim();
  settings.dirPath = $("dirPath").value.trim().replace(/^\/+|\/+$/g, "");
  save();
  try {
    await connect({ interactive: true });
    $("settingsStatus").textContent = `Connected ✓ — active directory: ${settings.dirPath}`;
    banner("okay", "Settings saved and signed in. Go to Run.");
  } catch (e) {
    $("settingsStatus").textContent = "";
    banner("error", e.message);
  }
});

async function connect({ interactive = false } = {}) {
  if (!settings.clientId) throw new Error("no OAuth Client ID — fill Settings first (see the app tutorial)");
  if (!settings.dirPath) throw new Error("no active Drive directory set — fill Settings first");
  await gsiReady();
  drive.initAuth(settings.clientId);
  await drive.getToken({ interactive });
  const meta = await drive.resolvePath("root", settings.dirPath);
  if (!meta) throw new Error(`Drive directory '${settings.dirPath}' not found under My Drive`);
  dirId = meta.id;
  await refreshListing();
}

function gsiReady() {
  return new Promise((resolve, reject) => {
    let waited = 0;
    (function poll() {
      if (window.google?.accounts?.oauth2) return resolve();
      if ((waited += 100) > 8000) return reject(new Error("Google sign-in script did not load — check the connection and reload"));
      setTimeout(poll, 100);
    })();
  });
}

// ---- listing & pickers ---------------------------------------------------
async function refreshListing() {
  listing = await drive.listChildren(dirId);
  const yamls = listing.filter((f) => /\.ya?ml$/i.test(f.name) && f.mimeType !== drive.FOLDER_MIME);
  const audios = listing.filter((f) => AUDIO_EXT.some((e) => f.name.toLowerCase().endsWith(e)));
  fillSelect($("courseSel"), yamls, settings.courseName || "course.yaml");
  fillSelect($("sessionSel"), yamls.filter((f) => f.name !== ($("courseSel").value || "course.yaml")), settings.sessionName);
  // newest audio first — in class, the file just recorded is the one wanted
  audios.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  fillSelect($("audioSel"), audios, settings.audioName);
}

function fillSelect(sel, files, preferred) {
  sel.innerHTML = "";
  for (const f of files) {
    const o = document.createElement("option");
    o.value = f.name;
    o.textContent = f.name;
    sel.appendChild(o);
  }
  if (preferred && files.some((f) => f.name === preferred)) sel.value = preferred;
}

function selected(sel) {
  const name = $(sel).value;
  const meta = listing.find((f) => f.name === name);
  if (!meta) throw new Error(`select a file in '${sel.replace("Sel", "")}' (refresh the listing?)`);
  return meta;
}

$("refreshBtn").addEventListener("click", () => guard(refreshListing));

// ---- canary (pre-class assurance) ----------------------------------------
async function runCanary() {
  const el = $("canary");
  el.textContent = "🩺…";
  el.className = "";
  try {
    const r = await fetch("../resources/system.yaml");
    const sys = parseYamlMapping(await r.text(), "system.yaml", window.jsyaml);
    const models = [sys.models?.transcription, sys.models?.generation].filter(Boolean);
    const results = await gemini.canary(models, settings.geminiKey);
    const bad = results.filter((x) => !x.ok);
    if (bad.length) {
      el.textContent = "🩺 KO";
      el.className = "bad";
      banner("error", `Model canary failed: ${bad.map((b) => `${b.model}: ${b.error}`).join(" · ")}`);
    } else {
      el.textContent = "🩺 OK";
      el.className = "ok";
      log(`🩺 canary: ${results.map((x) => `${x.model} → ${x.resolvedModel} (${x.seconds.toFixed(1)}s)`).join(" · ")}`);
    }
  } catch (e) {
    el.textContent = "🩺 ?";
    el.className = "bad";
    log(`🩺 canary error: ${e.message}`);
  }
}

// ---- phases --------------------------------------------------------------
let busy = false;
async function guard(fn) {
  if (busy) return;
  busy = true;
  clearBanner();
  for (const id of ["transcribeBtn", "generateBtn", "dryBtn", "refreshBtn"]) $(id).disabled = true;
  try {
    await fn();
  } catch (e) {
    log(`❌ ${e.message}`);
    banner("error", e.message);
  } finally {
    busy = false;
    for (const id of ["transcribeBtn", "generateBtn", "dryBtn", "refreshBtn"]) $(id).disabled = false;
  }
}

async function prepare() {
  if (!dirId) await connect({ interactive: true });
  if (!settings.geminiKey) throw new Error("no Gemini API key — fill Settings first");
  const courseMeta = selected("courseSel");
  const sessionMeta = selected("sessionSel");
  const audioMeta = selected("audioSel");
  settings.courseName = courseMeta.name;
  settings.sessionName = sessionMeta.name;
  settings.audioName = audioMeta.name;
  save();
  const resources = await loadResources(dirId, log);
  const cfg = await buildConfig({ dirId, courseMeta, sessionMeta, resources, warn: log });
  // Config echo — guards against a stale or wrong session file (2026-08-26 incident).
  log(`⚙️ session: ${sessionMeta.name} (modified ${sessionMeta.modifiedTime?.slice(0, 16).replace("T", " ")}) · course: ${courseMeta.name}`);
  const promptPreview = cfg.sessionPrompt ? (cfg.sessionPrompt.length > 60 ? cfg.sessionPrompt.slice(0, 60) + "…" : cfg.sessionPrompt) : "(none)";
  log(`   questions: ${cfg.questionCount} +${cfg.reservePercent}% → ${cfg.questionCountTotal} · quiz language: ${cfg.questionLanguage} · session prompt: ${promptPreview}`);
  log(`   audio: ${audioMeta.name} (${(Number(audioMeta.size) / 1e6).toFixed(1)} MB)`);
  return { cfg, audioMeta };
}

$("dryBtn").addEventListener("click", () =>
  guard(async () => {
    clearLog();
    await prepare();
    log("═══ dry check only — no API call, nothing written ═══");
  })
);

$("transcribeBtn").addEventListener("click", () =>
  guard(async () => {
    clearLog();
    const { cfg, audioMeta } = await prepare();
    await runTranscribe({ dirId, cfg, audioMeta, apiKey: settings.geminiKey, log });
    banner("okay", "Transcription done — review the transcript, then Generate.");
  })
);

$("generateBtn").addEventListener("click", () =>
  guard(async () => {
    clearLog();
    const { cfg, audioMeta } = await prepare();
    const { questions } = await runGenerate({ dirId, cfg, audioMeta, apiKey: settings.geminiKey, log });
    banner("okay", `${questions} questions written — open Files to review the GIFT.`);
  })
);

// ---- files & minimal editor (FC, 2026-08-27: outputs must be editable from
// the phone; any run file opens in a plain textarea and saves back to Drive) --
async function refreshFiles() {
  if (!dirId) await connect({ interactive: true });
  listing = await drive.listChildren(dirId);
  const systemFolder = listing.find((f) => f.name === "system" && f.mimeType === drive.FOLDER_MIME);
  systemListing = systemFolder ? await drive.listChildren(systemFolder.id) : [];
  const ul = $("filelist");
  ul.innerHTML = "";
  const rows = [
    ...listing.filter((f) => f.mimeType !== drive.FOLDER_MIME).map((f) => ({ f, prefix: "" })),
    ...systemListing.filter((f) => f.mimeType !== drive.FOLDER_MIME).map((f) => ({ f, prefix: "system/" })),
  ];
  for (const { f, prefix } of rows) {
    const li = document.createElement("li");
    const editable = TEXT_EXT.some((e) => f.name.toLowerCase().endsWith(e));
    const label = prefix + f.name;
    li.innerHTML = editable
      ? `<a href="#" data-id="${f.id}" data-name="${label}">${label}</a><span>${(f.modifiedTime || "").slice(0, 16).replace("T", " ")}</span>`
      : `<em>${label}</em><span>${(Number(f.size) / 1e6).toFixed(1)} MB</span>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", async (ev) => {
      ev.preventDefault();
      try {
        editorFile = { id: a.dataset.id, name: a.dataset.name };
        $("editorName").textContent = editorFile.name;
        $("editorText").value = await drive.downloadText(editorFile.id);
        $("editorCard").classList.remove("hidden");
      } catch (e) {
        banner("error", e.message);
      }
    })
  );
}

$("filesRefreshBtn").addEventListener("click", () => refreshFiles().catch((e) => banner("error", e.message)));
$("editorCloseBtn").addEventListener("click", () => $("editorCard").classList.add("hidden"));
$("editorSaveBtn").addEventListener("click", async () => {
  try {
    await drive.updateFile(editorFile.id, $("editorText").value);
    banner("okay", `${editorFile.name} saved to Drive.`);
  } catch (e) {
    banner("error", e.message);
  }
});

// ---- boot ----------------------------------------------------------------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

(async () => {
  if (settings.clientId && settings.dirPath) {
    try {
      await connect({ interactive: false }); // silent when the grant is remembered
      log(`📂 ${settings.dirPath} — ${listing.length} items`);
      if (settings.geminiKey) runCanary();
    } catch {
      banner("okay", "Tap any action to sign in to Google Drive.");
    }
  } else {
    document.querySelector('nav button[data-tab="settings"]').click();
    banner("okay", "First run: fill Settings once (see the app tutorial).");
  }
})();
