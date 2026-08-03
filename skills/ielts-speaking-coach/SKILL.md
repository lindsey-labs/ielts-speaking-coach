---
name: ielts-speaking-coach
description: Run repeatable IELTS speaking practice with ChatGPT Voice or a supported voice conversation. Use when a learner wants to import IELTS Speaking questions, choose Part 1, Part 2, Part 3, or a full mock test, create a 7-day, 14-day, or 30-day practice plan, conduct examiner-style practice, generate a fixed-format evidence-based review, save a personal issue and vocabulary record, or retrain one priority weakness from a previous session.
---

# IELTS Speaking Coach

Turn a voice conversation into a closed learning loop:

`freely choose a route → practise → review → save → optionally retrain → verify transfer`.

Use the host product's existing voice capability. The optional bundled Electron desktop app can open the ChatGPT web experience, send the saved IELTS prompt, request Voice, observe new conversation turns, and checkpoint the visible transcript to local storage as it changes. A structured review remains optional. The skill alone cannot control Voice; distinguish desktop-bridge behavior from an ordinary chat session.

## Route the request

- For an exam simulation, read `references/examiner-protocol.md`.
- For a study plan or question import, read `references/storage-schema.md`.
- For a post-session review, read `references/report-schema.md`.
- For focused practice based on a previous report, read `references/retraining-policy.md`.
- For a first run in a writable workspace, initialize the learner workspace with `scripts/init-workspace.mjs`.

## Start a practice session

When the local MCP tools are available:

1. Call `get_training_context` before continuing or retraining.
2. After the learner chooses a route, call `set_training_selection`.
3. Use the returned session ID for the post-session review.
4. If a dashboard-planned session exists when practice begins, use the saved route, Part, length, and goal immediately. Do not ask the learner to repeat them or require a special start phrase.
5. If the dashboard session has a `questionId` or exact `selectedReference`, practise that saved question immediately.
6. When the dashboard reports that the Electron desktop bridge is connected, let the learner use its buttons. Do not ask them to copy a start phrase.

1. Ask only for missing choices:
   - route: continue the last question, practise the next question in the bank, retrain a previous session or target, or choose any historical day/question;
   - allow `choose_question` when the learner selects an exact topic or question in the dashboard;
   - mode when applicable: `Part 1`, `Part 2`, `Part 3`, or `full mock`;
   - length: `quick`, `standard`, or `full`;
   - question source: imported bank, recent plan, or built-in sample;
   - feedback timing: after the session by default.
2. Show a one-screen session card containing the mode, approximate length, and today's single goal.
3. In the browser-only fallback, tell the learner to begin or continue in Voice. In the desktop app, rely on the saved selection and one-click start.
4. Enter examiner mode and follow `references/examiner-protocol.md`.
5. Do not coach, correct, praise, or expose scores during examiner mode.
6. End examiner mode only when the selected flow finishes or the learner says `结束训练`.

Do not force the learner to retrain the latest issue. At the beginning of every session, preserve the four route choices. A report may recommend a target, but it must not automatically replace the learner's next planned question.

## Review the session

1. Use only evidence actually present in the transcript or supplied recording.
2. Separate must-correct errors, naturalness improvements, and optional vocabulary upgrades.
3. Quote the learner's words before suggesting a change.
4. Mark any uncertain transcript evidence as `needs verification`.
5. Follow the exact section order and field names in `references/report-schema.md`.
6. Recommend exactly one optional future retraining target. Save it without making it the mandatory next session.
7. Save the Markdown and JSON report when the environment permits file writes. Never rely on chat memory as the sole learning record.
8. When `save_session_review` is available, call it after showing the fixed-format report. Pass both the complete Markdown report and the section 10 JSON record.
9. When the desktop bridge completes a session, treat its locally saved transcript and report as the source of truth; do not create a duplicate session.

## Retrain one target

1. Ask the learner which previous question, session, day, or saved target to retrain. Offer the latest unresolved target as a recommendation only.
2. Use the four-stage ladder in `references/retraining-policy.md`:
   `isolate → scaffold → timed transfer → new-topic transfer`.
3. Keep the session between 5 and 12 minutes.
4. Do not introduce a second target unless the first target passes the transfer check.
5. Update the target status as `new`, `training`, `initially-improved`, or `stable`.

## Create a plan

1. Normalize imported questions using `references/storage-schema.md`.
2. Preserve the source title, URL, original wording, and whether the import contains full questions or topic-outline entries.
3. Generate a 7-day, 14-day, or 30-day plan.
4. Mix new questions, repeated questions, and focused retraining.
5. Add unresolved targets as optional review slots without replacing the learner's freedom to continue the question bank.
6. Set one visible goal for each session.

## Dashboard handoff

When a writable local workspace is available:

1. When the learner asks to see or open the dashboard, call `open_dashboard`.
2. Prefer `initialize_ielts_workspace` and `get_dashboard_data` when the local MCP tools are available.
3. Use `list_question_bank` to show imported Part 1, Part 2, and Part 3 choices. Save an exact dashboard choice with `set_training_selection`.
4. Store learner data outside the installed skill folder.
5. Otherwise initialize `ielts-speaking-workspace/` with `scripts/init-workspace.mjs`.
6. Open `ielts-speaking-workspace/dashboard.html` in the browser.
7. Regenerate the dashboard after a report, question import, or target status changes.

## Desktop workflow

1. Start the bundled app with `npm run desktop` during local development or the installed Windows shortcut after packaging.
2. Let the learner log in to ChatGPT inside the separate persistent ChatGPT window. Never handle credentials for them.
3. Save the route, Part, exact question, length, and optional goal in the dashboard.
4. Use **保存并一键启动Voice** to send the examiner prompt and request Voice.
5. While the ChatGPT window is open, let the desktop adapter capture each visible user and assistant turn and checkpoint the transcript locally. Do not wait for review generation before saving the training record.
6. When Voice ends, the desktop bridge automatically asks the same conversation for delimited review JSON and caches the result locally. The learner then uses **同步复盘报告** to write the report, issues, vocabulary, and optional target into the local learning record.
7. If automatic generation does not start, use **补生成复盘报告** to generate from the locally saved transcript. Then use **同步复盘报告**. Keep both controls fixed in name and purpose; synchronization must not silently trigger generation.
8. If ChatGPT changes its web controls and automatic Voice start fails, keep the sent prompt and fall back to one manual click in the ChatGPT window. If transcript selectors change, show a visible capture warning instead of claiming that the record was saved.

If local writes are unavailable, return the report in Markdown and JSON so the learner can save it manually.

## Voice limitations

- In ChatGPT-web mode, treat pause detection and turn timing as host-platform behavior.
- Encourage natural waiting, but never promise control over Voice end-of-turn detection.
- Do not invent pronunciation judgments from text alone.
- Do not present an estimated band as an official IELTS score.
