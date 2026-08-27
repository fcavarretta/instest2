You are given the audio recording of a university lecture: a session of the course "$course_name", dated $session_date. A single lecturer speaks; students occasionally intervene. The lecture is delivered predominantly in $dominant_language, with occasional words, phrases or quotations in $other_language.

Produce a clean verbatim transcript of the lecture.

Cleaning rules:

- Remove filler sounds ("euh", "um", "uh"), hesitations, false starts, and immediate self-corrections — keep only the corrected version of each sentence.
- Do NOT summarize, paraphrase, condense, translate, or reorder anything. Keep the lecturer's own wording and ALL content, including examples, anecdotes and asides.
- Keep passages spoken in $other_language exactly in that language; never translate them.
- Student interventions: if clearly audible, transcribe them briefly, prefixed with "[Question étudiant]" when the lecture is in French or "[Student question]" when it is in English; if inaudible, insert a one-line bracketed summary of what was asked. Transcribe the lecturer's answer normally — Q&A often carries examinable content.
- Use standard punctuation and correct spelling, including proper names and technical terms.

Output format — plain Markdown only:

- Insert a short "## " section heading when the lecturer clearly moves to a new topic.
- Otherwise write ordinary paragraphs.
- No timestamps, no speaker labels, no preamble, no commentary, no conclusion of your own: output the transcript text and nothing else.
