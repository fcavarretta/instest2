#!/usr/bin/env python3
"""TSCT v1.0 entry point: audio file -> clean transcript -> GIFT questions.

Usage:
    python3 run_qcm.py <session.yaml> --audio <file>   # full pipeline
    python3 run_qcm.py <session.yaml> --dry-run        # show prompts + plan, no API call
    python3 run_qcm.py <session.yaml> --transcribe-only --audio <file>
    python3 run_qcm.py <session.yaml> --generate-only --transcript <X.transcript.md>

Outputs land beside the audio file (or in --output-root), named after it:
X.transcript.md, X.questions.gift, X.questions.json, X.metadata.yaml.

The session YAML is the single argument; course.yaml and system.yaml are
discovered from it (see lib/config.py). Callable from Colab as
run_qcm.main([...]) — all environment differences live in lib/io_layer.py.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import sys
from pathlib import Path

from lib import gemini_client, gift, io_layer, questions, runfolder
from lib.config import LANG_NAMES, ConfigError, find_course_yaml, load_config, other_language
from lib.costs import console_summary, usage_metadata
from lib.prompts import PromptError, load_template, render

TRANSCRIPT_PLACEHOLDER = "[... transcript inserted here at run time ...]"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate a Moodle GIFT quiz from a recorded lecture.")
    parser.add_argument("session", type=Path, help="path to the session YAML (its course folder must hold course.yaml)")
    parser.add_argument("--course", type=Path, default=None, help="the course.yaml to use (default: two levels above the session file)")
    parser.add_argument("--system", type=Path, default=None, help="override resources/system.yaml")
    parser.add_argument("--env-file", type=Path, default=None, help="override the Gemini key env file")
    parser.add_argument("--dry-run", action="store_true", help="render prompts and plan, no API call")
    parser.add_argument("--transcribe-only", action="store_true", help="stop after the transcript")
    parser.add_argument("--generate-only", action="store_true", help="skip transcription (requires --transcript)")
    parser.add_argument("--transcript", type=Path, default=None, help="existing X.transcript.md for --generate-only")
    parser.add_argument("--model-transcription", default=None, help="override the transcription model")
    parser.add_argument("--model-generation", default=None, help="override the generation model")
    parser.add_argument("--audio", type=Path, default=None, help="override the session's audio_file (e.g. a Drive path in Colab)")
    parser.add_argument("--output-root", type=Path, default=None, help="optional folder for outputs (default: beside the audio)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.generate_only and not args.transcript:
        print("❌ --generate-only requires --transcript <path>", file=sys.stderr)
        return 2
    if args.generate_only and args.transcribe_only:
        print("❌ --generate-only and --transcribe-only are mutually exclusive", file=sys.stderr)
        return 2

    try:
        cfg = load_config(args.session, args.system, args.model_transcription, args.model_generation, args.course)
    except ConfigError as e:
        print(f"❌ config: {e}", file=sys.stderr)
        return 1
    if args.audio:
        cfg = dataclasses.replace(cfg, audio_file=args.audio.resolve())
    if cfg.audio_file is None and not args.generate_only and not args.dry_run:
        print("❌ no audio source: set audio_file in the session YAML or pass --audio", file=sys.stderr)
        return 2

    out_dir = args.output_root.resolve() if args.output_root else cfg.output_root
    source = Path(args.transcript).resolve() if args.generate_only else cfg.audio_file

    # Config echo — guards against a SESSION path pointing at a stale or wrong file:
    # check the path and its modification time against what you think you just edited.
    session_path = args.session.resolve()
    mtime = datetime.datetime.fromtimestamp(session_path.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
    print(f"⚙️  Session file: {session_path}  (modified {mtime})")
    print(f"   Course file:  {find_course_yaml(session_path, args.course)}")
    prompt_preview = (cfg.session_prompt[:60] + "…") if len(cfg.session_prompt) > 60 else (cfg.session_prompt or "(none)")
    print(f"   Questions: {cfg.question_count} +{cfg.reserve_percent}% → {cfg.question_count_total} · quiz language: {cfg.question_language} · session prompt: {prompt_preview}")

    dominant = LANG_NAMES[cfg.dominant_language]
    transcription_vars = {
        "course_name": cfg.course_name,
        "session_date": cfg.session_date,
        "dominant_language": dominant,
        "other_language": LANG_NAMES[other_language(cfg.dominant_language)],
    }
    generation_vars = {
        "course_name": cfg.course_name,
        "question_count_total": cfg.question_count_total,
        "question_language": LANG_NAMES[cfg.question_language],
        "course_prompt": cfg.course_prompt or "(none)",
        "session_prompt": cfg.session_prompt or "(none)",
    }

    try:
        transcription_prompt = render(load_template(cfg.prompt_transcription), transcription_vars)
        generation_template = load_template(cfg.prompt_generation)
        if args.dry_run:
            generation_prompt = render(generation_template, {**generation_vars, "transcript": TRANSCRIPT_PLACEHOLDER})
    except PromptError as e:
        print(f"❌ prompts: {e}", file=sys.stderr)
        return 1

    if args.dry_run:
        audio = cfg.audio_file
        if audio is None:
            audio_line = "(not set — will need --audio or audio_file in the session YAML)"
            outputs_line = "(depends on the audio path)"
        else:
            if audio.exists():
                size = audio.stat().st_size
                audio_line = f"{audio}  ({size / 1e6:.1f} MB — uploaded via the Files API)"
            else:
                audio_line = f"{audio}  (NOT FOUND — drop the file there before a real run)"
            outputs_line = runfolder.plan_outputs(audio, out_dir).describe()
        print("═══ DRY RUN — no API call ═══")
        print(f"Audio:        {audio_line}")
        print(f"Context:      {[str(p) for p in cfg.context_files] or '(none)'}")
        print(f"Models:       {cfg.model_transcription} (transcription), {cfg.model_generation} (generation)")
        print(f"Questions:    {cfg.question_count} target + {cfg.reserve_percent}% reserve = {cfg.question_count_total} asked")
        print(f"Outputs:      {outputs_line}")
        print("\n─── Transcription prompt ───\n")
        print(transcription_prompt)
        print("\n─── Generation prompt ───\n")
        print(generation_prompt)
        return 0

    try:
        api_key = io_layer.get_api_key(args.env_file)
    except io_layer.SecretError as e:
        print(f"❌ secrets: {e}", file=sys.stderr)
        return 1

    plan = runfolder.plan_outputs(source, out_dir)
    print(f"📁 Outputs: {plan.describe()}")
    usages = []

    try:
        if args.generate_only:
            transcript = runfolder.read_transcript(source)
            print(f"📄 Reusing transcript: {source} ({len(transcript.split())} words)")
        else:
            print(f"🎙️  Transcribing {cfg.audio_file.name} with {cfg.model_transcription}…")
            try:
                transcript, usage = gemini_client.transcribe(cfg, transcription_prompt, api_key)
            except gemini_client.TruncationError as e:
                path = runfolder.write_text(plan, "transcript.partial.md", e.partial_text)
                banner = "⛔" * 30
                print(f"\n{banner}\n⛔ TRANSCRIPT TRUNCATED — INCOMPLETE, DO NOT USE AS-IS\n"
                      f"⛔ {e}\n⛔ partial saved to {path}\n{banner}", file=sys.stderr)
                return 1
            usages.append(usage)
            path = runfolder.write_transcript(plan, cfg, transcript, usage)
            print(f"📄 Transcript: {path} ({len(transcript.split())} words)")

        if not args.transcribe_only:
            print(f"❓ Generating {cfg.question_count_total} questions with {cfg.model_generation}…")
            generation_prompt = render(generation_template, {**generation_vars, "transcript": transcript})
            try:
                raw, usage = gemini_client.generate_questions(cfg, generation_prompt, api_key)
            except gemini_client.TruncationError as e:
                path = runfolder.write_text(plan, "questions.partial.json", e.partial_text)
                banner = "⛔" * 30
                print(f"\n{banner}\n⛔ QUESTIONS TRUNCATED — INCOMPLETE, DO NOT USE\n"
                      f"⛔ {e}\n⛔ partial saved to {path}\n{banner}", file=sys.stderr)
                return 1
            usages.append(usage)
            runfolder.write_text(plan, "questions.json", raw)
            parsed = questions.parse_questions(raw)
            questions.check_count(parsed, cfg.question_count_total, cfg.question_count)
            gift_text = gift.render_gift(
                parsed,
                course_code=cfg.course_code,
                session_id=cfg.session_id,
                session_date=cfg.session_date,
                model=cfg.model_generation,
                category_header=cfg.gift_category_header,
            )
            path = runfolder.write_text(plan, "questions.gift.md", gift_text)
            print(f"✅ {len(parsed)} questions → {path}")
    except (gemini_client.ApiError, questions.QuestionError, FileNotFoundError) as e:
        print(f"❌ {e}", file=sys.stderr)
        return 1
    finally:
        if usages:
            runfolder.write_metadata(
                plan,
                {
                    "course_code": cfg.course_code,
                    "session_id": cfg.session_id,
                    "session_date": cfg.session_date,
                    "audio_file": cfg.audio_file.name if cfg.audio_file else None,
                    **usage_metadata(usages, cfg.pricing),
                },
            )
            print(console_summary(usages, cfg.pricing))

    return 0


if __name__ == "__main__":
    sys.exit(main())
