---
title: TSCT app tutorial
created: 2026-08-27
modified: 2026-08-27
intent: one-time app setup and three-tap class use
tags: [tsct, app, pwa, tutorial]
---

# TSCT QCM app — tutorial

The app replaces the Colab ritual. **Parametrize once (section A). Thereafter, class use is section B: open the app → point at the recorded file → Transcribe → Generate. Nothing else, ever.**

## A. One-time setup

### A.1 Register the app's OAuth client (developer act, ~10 min, once ever)

The app talks to *your* Drive, so Google requires an OAuth "client" registered under your account. This is app-manufacturing, not app-usage — done once, then forgotten.

1. Open <https://console.cloud.google.com/> (sign in with the Google account whose Drive holds the course files).
2. Pick a project to host the client — **reusing an existing project is fine** (e.g. the one AI Studio created for the Gemini key); the project is only a container for this one credential, nothing else. Only create a new one (`tsct-app`) if your existing project's OAuth consent screen is already **"In production"** for another app you operate — Testing mode (below) is project-wide and you don't want to fight over it.
3. Menu ☰ → **APIs & Services → Library** → search **Google Drive API** → **Enable**.
4. **APIs & Services → OAuth consent screen** (Google brands this "Google Auth Platform"):
   - The setup wizard asks App name (`TSCT QCM`), your email as support/developer contact, then Contact Information → agree → **Create**. (On a personal Gmail account there is no Internal/External choice — External is the only option, so the wizard doesn't show it.)
   - **After the wizard**: left sidebar → **Audience** page → Publishing status stays **Testing** (forever — invisible in daily use, no verification process) → **Test users → + Add users**: add your own Gmail address → Save.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**, name `TSCT QCM web`.
   - **Authorized JavaScript origins**: add `https://fcavarretta.github.io`
   - **Create**, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).

### A.2 Fill the app's Settings (once per device/browser)

1. Open the app: <https://fcavarretta.github.io/instest2/app/> — then browser menu → **Add to Home screen** to install it.
2. **Settings** tab:
   - **Google OAuth Client ID**: paste the ID from A.1.
   - **Gemini API key**: paste your key (same value as the Colab `GEMINI` secret).
   - **Active Drive directory**: the path of the course directory from My Drive root, e.g. `_TSCT`.
3. **Save & sign in** → Google's account chooser appears → pick the account → **Allow**. The grant is remembered; you will not be asked again in normal use.

That's it. The settings live on the device; nothing of yours passes through the hosting URL.

## B. Class use (three taps)

Prerequisite, unchanged from today: the phone's recorder app saved the lecture audio into the active Drive directory.

1. Open the app. The 🩺 chip top-right is the pre-class canary: **OK** = both models answered a test call seconds ago.
2. **Run** tab: the newest audio file is already selected (pickers remember your course/session choice; **↻ Refresh** re-reads the directory).
3. Tap **🎙️ Transcribe**. Wait for `📄 Transcript: …` (the log shows progress and cost).
4. Tap **❓ Generate**. Wait for `✅ N questions → ….questions.gift.md`.

Outputs land beside the audio in Drive, exactly like the CLI: `X.transcript.md`, `X.questions.gift.md` (pure GIFT inside — the `.md` extension is so any editor on the phone can open it), plumbing in `system/` (`X.questions.json`, `X.metadata.yaml`, per-phase run logs), previous versions auto-archived into `old/`.

**Review**: the **Files** tab lists the directory; tap any text file (transcript, GIFT, yamls) to edit it right in the app and **💾 Save** back to Drive. Moodle import stays manual and unchanged (import format: GIFT — the `.md` extension does not matter).

**Dry check** renders the config without calling anything — use it to verify which session/course/audio would run and at what parameters.

## C. Prompt & parameter tuning (no app release ever needed)

The app ships default resources (system.yaml + the two prompt templates) from the repo. To override any of them: create a `resources/` folder **in the active Drive directory** and put there the element(s) to change, same names and layout (`system.yaml`, `prompts/transcription.txt`, `prompts/generation_system.txt`). Any element present there wins, element-wise; delete the file to fall back to the default. Editable from any device — including the app's own Files tab.

## D. Troubleshooting

- **🩺 KO**: the named model is unavailable or the key is bad — fix before class; questions/transcription would fail the same way.
- **Sign-in popup blocked**: tap the action button again (browsers require a user gesture the first time).
- **"Drive directory not found"**: the Settings path is spelled from My Drive root, `/`-separated, no leading slash.
- **Truncation banner (⛔)**: Google flagged the output as cut (MAX_TOKENS). The partial is saved as `*.partial.*` for salvage; raise `max_output_tokens` (via a Drive `resources/system.yaml` override) and rerun.
- **App update**: deploys are `git push`; the app picks the new version on the next open (it caches itself for offline starts, then checks the URL).
