---
title: TSCT Colab tutorial
created: 2026-08-25
modified: 2026-08-27
intent: terse step-by-step operation of the QCM pipeline in Colab
tags: [tsct, colab, tutorial, workflow]
---

# TSCT / instest — Colab tutorial (v1)

Production code lives in the **public** repo `fcavarretta/instest` (a nested sub-repo of the private TSCT project: `TSCT (v)/5 Prod (instest)/`). Development things (tests, test data) stay in the private repo under `2 Dev/`.

Mental model: **4 places.** Your machine (VS Code, real disk) · GitHub (repo's home) · Google Drive (audio in, results out) · Colab loaner VM (`/content`, **wiped when the runtime ends** — only pushed edits survive).

## A. First-time setup (once ever)

- [ ] **Google account**: use the account whose Drive holds the recordings, everywhere below.
- [ ] **GitHub token** (only needed to ⬆ PUSH edits back — the repo is public, reading needs nothing): github.com → Settings → Developer settings → Fine-grained tokens → Generate.
  - Repository access: *Only select repositories* → `fcavarretta/instest`.
  - Permissions → Contents: **Read and write**.
  - Copy the token immediately (shown once).
- [ ] **Colab**: sign in at https://colab.research.google.com.
- [ ] **Secrets** (🔑 icon, left sidebar of any open notebook) — add both, toggle *Notebook access* ON:
  - `GEMINI_API_KEY` = value from `.env/gemini.env` (after the `=`).
  - `GITHUB_TOKEN` = the token above.
- [ ] **No GitHub authorization needed to open** — the repo is public. Direct URL (bookmark it; keep `?authuser=1` if several Google accounts are signed in): `https://colab.research.google.com/github/fcavarretta/instest/blob/master/notebook/run_qcm.ipynb`
- [ ] **Drive**: put the session recording somewhere in My Drive; note its path (e.g. `TSCT/11.05.m4a`).

## B. Entering a work session (each time)

1. **Open the notebook**: File → Open notebook → **GitHub** tab → `fcavarretta/instest` → `notebook/run_qcm.ipynb`. (Later: File → Recent notebooks remembers it. Never upload the file — always this door.)
2. **Connect the runtime**: top-right of the toolbar row (right of "+ Code + Text"), click **Connect** — if a dropdown opens, pick **Connect to a hosted runtime** (not local, not GCE VM, not the Drive entries). Wait for the green ✓ with RAM/Disk gauges. No machine = "Not connected to a runtime" errors.
3. **Runtime → Run all.**
4. First popup: *Permit access to Google Drive* → **Connect to Google Drive** → pick the account → on the long permission list (Drive, photos, mobile config…), **tick ALL boxes** (*Select all*) → Continue. Partial grants make the mount fail. Scope: your own notebook acting as you, this session only. Success = cell 1 prints `Mounted at /content/drive`.
5. Watch the cells: Drive mount ✓ → repo cloned to `/content/instest` ✓ → pipeline cell runs.
6. The Setup section ends with the **🩺 MODELS CHECK** (a tiny live ping per model: key valid, quota not exhausted — ⛔ means do not count on it in class; true billing balance is only visible in Google Cloud → Billing → Budgets, set an alert there) and the **Course cell**: its `COURSE` field names the `course.yaml` applying to the sessions below.
7. Session cells: **parameters** (`AUDIO`, `SESSION` fields; run first), then **TRANSCRIBE** (audio → `X.transcript.md`) and **GENERATE** (transcript → `X.questions.gift`; runs without transcribing when the transcript already exists — the regeneration case), then a **⏹ STOP** cell that halts a *Run all* before anything below it. Both step cells carry a `HALT_ON_FAILURE` checkbox (default on): any failure — including a Google-flagged truncation — prints a ⛔ banner AFTER saving partials/metadata, then halts the queue; untick to continue instead. Resume after a halt by simply running the next cell. To chain cells: **Shift+Enter** repeatedly, or select them → *Runtime → Run selection*.

## C. Editing and saving from class

- **See/edit any file** (YAMLs, prompts): 📁 Files panel (left sidebar) → `/content/instest/…` → double-click to edit. Takes effect on the next run of the pipeline cell (do NOT re-run the sync cell before saving).
- **⬆ PUSH cell** (bottom): run it after any edit, and always **before leaving class** → commits + pushes everything to GitHub. Wait for `✅ Pushed to GitHub`.
- **⬆ Auto-PUSH cell** (Setup section, runs with *Run all*): at arm time it PROBES that pushing is possible (read-only/expired token → immediate ⚠️, also printed under the cell), runs a first check synchronously, then re-checks every `AUTOSAVE_MINUTES` minutes; the status line always shows the last successful push (✅ + time) or the problem (⚠️). Re-running the cell supersedes the previous loop. Safety net only — still run ⬆ PUSH at the end.
- **The notebook itself is covered too**: auto-push and ⬆ PUSH snapshot the live notebook document into the repo before sending (outputs stripped) — *File → Save a copy in GitHub* is no longer needed. Pulling the notebook is still F5 on its URL.
- Back home: `git pull` in `TSCT (v)` brings class edits to VS Code (or ask the AI).
- **Notebook refresh**: the GitHub-opened notebook's URL is a live pointer — **F5 re-fetches the latest version** (bookmark that URL). Needed only when the notebook file itself changed; everything else syncs via the sync cell.
- **Explicit-master rule**: at any moment one side is master of the whole repo — this side (Colab) or home (VS Code / the AI). The non-master side changes nothing without checking with the master first. The current master is recorded in `Instructions.md` → *Working rules*; FC switches it by saying so.

## D. Preparing a class (before the day)

**Parameter structure — 3 layers, later overrides earlier:**

| File | Scope | Holds | How it is found |
|---|---|---|---|
| `system.yaml` | everything | models, reserve %, prompt templates, pricing | by the code (next to it, in `resources/`); `--system` overrides |
| `course.yaml` | one course | course name, languages, course prompt, course context | **the `COURSE` field** (Setup section) |
| `session-*.yaml` | one session | id, date, session prompt, question count, session context | **the `SESSION` field** of the session's parameters cell |

**No structural constraint**: both files can live anywhere (Drive or repo), any names, flat or nested — the two notebook fields bind everything. (Fallback for bare CLI use: with no `--course`, a file named `course.yaml` two levels above the session file is tried.)

Convention: `*` = compulsory (run fails without it) · unmarked = optional, comment states the default behavior when absent.

**course.yaml** (complete):
```yaml
course_code: MONCOURS        # * names the outputs' category
course_name: "Nom du cours"  # *
dominant_language: fr        # * language SPOKEN in the audio (fr|en)
question_language: fr        # * language OF THE QUIZ (fr|en) — a session may override
course_prompt: ""            #   standing instruction for every session — default: none
context_files: []            #   files/folders, spelling authority — default: no context
schedule: {}                 #   dates/hours for future app versions — default: none, unused in v1
```

**sessions/s1.yaml** (complete — every line optional; an empty file is valid):
```yaml
session_id: 1                          #   prefixes question names (S1-Q01) — default: plain Q01
session_date: 2026-08-25               #   default: today
session_prompt: "Focus X ; ignorer Y." #   2 lines, injected last, top priority — default: none
question_count: 15                     #   default: inherited (course, else system: 10)
question_language: en                  #   default: the course value
context_files: []                      #   that day's slides, appended to course's — default: none
audio_file: some.m4a                   #   default: none — the cell's AUDIO field provides it (and wins)
```

`question_count` cascades: settable in system, course, or session yaml — **lowest level wins**; error only if absent everywhere (system carries 10).

`context_files` syntax — `[]` = empty list (line deletable); entries: a file, a folder (→ its `.pdf`/`.txt`/`.md`, alphabetical), or a glob (`'*'`, `'slides/*.pdf'`); pipeline outputs (transcripts, questions, metadata, logs) are auto-excluded from folder/glob expansion; relative = from that yaml's own folder; absolute `/content/drive/…` allowed; ≤14 MB total:
```yaml
context_files: [syllabus.pdf]                  # one file
context_files: [slides, biblio.pdf]            # a folder + a file
```
Any `[]` or `#`-commented line in these files is optional; the uncommented scalar lines are the compulsory ones.

**system.yaml** (complete; in the repo: `/content/instest/resources/system.yaml` — auto-found, all courses; already filled, never create it):
```yaml
models:                              # *
  transcription: gemini-pro-latest   # * audio → transcript
  generation: gemini-pro-latest      # * transcript → questions
reserve_percent: 20                  # * 15 asked → 18 generated
question_count: 10                   #   system-wide default target — course/session override
transcription:                       # *
  max_output_tokens: 65536           # *
  temperature: 0.3                   # * 0 literal … 1 creative
  thinking_level: low                #   low | high — default: model decides
generation:                          # *
  max_output_tokens: 65536           # *
  temperature: 0.7                   # *
  thinking_level: high               #   default: model decides
output_root: null                    #   folder override — default: outputs beside the audio (cell's OUTPUT wins)
prompts:                             # *
  transcription: prompts/transcription.txt    # * prompt TEXTS live in these .txt files (txt so Colab can edit them; .md is preview-only there)
  generation: prompts/generation_system.txt   # *
gift:
  category_header: true              #   $CATEGORY line in the .gift — default: true
pricing: {…}                         #   $/1M for the cost log only — default: cost shown as "no pricing entry"
```
Worth changing: `models`, `reserve_percent`, `temperature`s, and the prompt `.txt` texts. The rest is plumbing.

## E. Results

Outputs land **beside the audio file** (the cell's `OUTPUT` field, optional, redirects them to a folder), named after it:
- `X.transcript.md` — clean transcript (the archive; reusable via `--generate-only`)
- `X.questions.gift` — review, then import into Moodle
- `system/X.questions.json` — raw model output (debug / regeneration)
- `system/X.metadata.yaml` — tokens + $ per call (plumbing lives in `system/`, keeping the folder clean)

**Head convention**: the canonical name always holds the most recent version; on a re-run, the previous file moves into an `old/` subfolder beside it, renamed with its own timestamp (`old/X.questions-2026-08-25 19-36-13.gift`) — the console prints a ♻️ line when that happens. `X.metadata.yaml` is a log: it accumulates all calls in place. Cost prints at the end of the cell.

## F. Production — after a real class

1. Stop the phone recording.
2. **Upload the file to Drive** (Drive app on the phone, or drive.google.com): folder `TSCT/`, name it with date + session (e.g. `2026-09-15 s2.m4a`).
3. Open the notebook (File → Recent notebooks) → **Connect** → *Runtime → Run all* (mounts Drive, syncs the repo).
4. **Step 1 — TRANSCRIBE**: in the session's first cell, set `AUDIO` to the new file's Drive path (and `SESSION` if new); run it. A 90′ recording takes minutes (compression note, then silence is normal). Optionally open `X.transcript.md` for a quick look.
5. **Step 2 — GENERATE**: run the session's second cell (it picks the latest transcript automatically). To chain both without pause: Shift+Enter twice from step 1.
6. **Review**: in Drive, beside the audio → open `X.questions.gift` (any text editor) → delete weak questions, fix wording. (~18 delivered for a 15-question target: trimming is the design.)
7. **Moodle import**: course → Question bank → Import → format **GIFT** → upload the reviewed `questions.gift` → import → build the quiz from the new category.
8. If you touched YAMLs/prompts during the session: run the **⬆ PUSH cell** before closing.

## G. Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `Not connected to a runtime` | no loaner machine attached | click **Connect** (top-right), wait for green ✓ |
| `⚠️ Local edits not yet saved — skipping the pull` | sync cell protecting unpushed class edits | run the ⬆ PUSH cell, then re-run sync cell |
| `push FAILED` in ⬆ PUSH / Auto-PUSH | token lacks write, or expired | recreate token (Contents: Read **and write**), update the secret |
| `GEMINI_API_KEY not found` | secret missing or *Notebook access* off | 🔑 panel: add/enable, then Runtime → Restart and run all |
| `no audio source` | neither `--audio` nor `audio_file` set | fix the `AUDIO` path in the session cell |
| Audio file not found | wrong Drive path | check exact path in Drive; prefix is `/content/drive/MyDrive/` |
| Auto-push status frozen (old `checked HH:MM`) | the runtime died (idle ~90 min kills it); a dead kernel cannot update the display | Reconnect → *Run all*; the `checked` time IS the freshness indicator |
| `PUSH NOT POSSIBLE` right after a runtime restart | remote not re-pointed with the token yet | run ⬇ PULL, then re-run Auto-PUSH; if it persists, read its `git said:` line |
| Cell output turns red, other cases | — | copy the whole cell output to the AI |
