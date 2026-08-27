# instest2 — MCQ quiz generator from recorded lectures (app stage)

Record a lecture → clean transcript → multiple-choice questions → Moodle GIFT import. Two Gemini calls (native-audio transcription, then question generation). This repo is the **app-stage successor** of [`instest`](https://github.com/fcavarretta/instest): the same pipeline, now driven by an installable web app instead of a Colab notebook.

- **The app** (`app/`): a PWA served by GitHub Pages — sign in to Google Drive once, point at the recorded audio file, **Transcribe**, **Generate**. Outputs (transcript, GIFT questions, metadata, run logs) land in the Drive directory beside the audio, same conventions as the CLI. Setup and daily use: [`app/App tutorial.md`](app/App%20tutorial.md).
- **Reference implementation** (`scripts/`): the Python CLI (`scripts/run_qcm.py` + `scripts/lib/`) is the pipeline's reference and test oracle; the app's JS core (`app/core/`) is validated against it fixture-for-fixture. The Colab notebook (`notebook/`) is kept as a fallback environment.
- **Parameters**: 3-layer YAML cascade — `resources/system.yaml` (global) → `course.yaml` → session yaml (lowest wins). The app ships `resources/` as bundled defaults; a `resources/` folder in the active Drive directory overrides any element of it, element-wise.

Requires a Gemini API key (entered once in the app's settings; Colab secret `GEMINI_API_KEY` for the notebook) and, for the app, a Google OAuth client ID (one-time registration — see the app tutorial).
