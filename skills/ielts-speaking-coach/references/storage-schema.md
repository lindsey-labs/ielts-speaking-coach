# Question, plan, and learner storage

Store learner data outside the installed skill so updates do not overwrite it.

## Workspace

```text
%LOCALAPPDATA%/IELTS Speaking Coach/
├── state.json
└── reports/
    ├── <session-id>.md
    └── <session-id>.json
```

Recordings are optional and require explicit learner consent.

`state.json` schema version 3 stores `sessions`, `targets`, `issues`, `vocabulary`, `questions`, and question-source metadata. An active desktop session checkpoints its visible transcript as ChatGPT conversation turns change; a completed reviewed session adds the structured report. Aggregate issue and vocabulary indexes must refer back to source session IDs.

## Question schema

```json
{
  "id": "p3-education-001",
  "part": 3,
  "topic": "Education",
  "prompt": "Should schools teach practical skills?",
  "followups": [
    "Which practical skills are most important?",
    "Who should decide what schools teach?"
  ],
  "source": "Imported bank",
  "sourceUrl": "https://example.com/question-bank",
  "importLevel": "full-question",
  "status": "new"
}
```

Normalize CSV, Markdown, JSON, Word, or PDF input into this shape. Preserve source wording. Flag ambiguous Part classification for confirmation.

When a protected source exposes only its topic outline, store `importLevel` as
`topic-outline`. Display those entries as topic-level training choices and do
not pretend that unavailable subquestions or audio were imported.

## Plan rules

For 7, 14, or 30 days:

- cover every question in the selected scope exactly once;
- distribute the questions as evenly as possible across scheduled training days;
- allow each day's question bundle to be completed in multiple Voice sessions;
- track `completedQuestionIds` on the plan item, and mark the day complete only when every question ID for that day is complete.

When starting a plan session, show the remaining questions and let the learner select a manageable subset. Unselected questions remain on that day. Give each session one visible goal.

Treat this mix as a recommendation. On each training day, let the learner choose:

1. continue the last completed question;
2. move to the next question in the bank;
3. retrain the previous session;
4. select any historical question, day, or saved target.

## Data safety

- Do not write API keys into the workspace.
- Do not store audio by default.
- Make deletion and export possible.
- Treat the report files as the source of truth, not model memory.
