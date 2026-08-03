# Standard review report

Use every section in this order. Write the report in the learner's preferred language while keeping English evidence unchanged.

## 1. Session snapshot

- Date
- Part and topics
- Duration if known
- Number of answered questions
- Evidence quality: high, medium, or limited

## 2. What worked

List no more than three specific strengths with transcript evidence.

## 3. Must-correct expressions

| Learner said | Correction | Why it matters | Mini drill |
|---|---|---|---|

Include actual errors only. Do not mix optional upgrades into this section.

## 4. More natural alternatives

| Learner said | More natural version | Usage note |
|---|---|---|

Preserve the learner's intended meaning.

## 5. Vocabulary upgrades

| Basic/repeated word | Better expression | Collocation or example | Priority |
|---|---|---|---|

Prefer precise, usable language over rare “advanced” vocabulary.

## 6. Repeated words and speaking habits

Record fillers, repeated openings, self-correction patterns, unfinished clauses, and overused linking phrases. Include approximate counts only when the transcript supports them.

## 7. Logic and development

For each material issue, show:

`original answer shape → missing link → improved answer shape`

Focus on relevance, explanation, examples, comparison, and conclusion.

### Per-question high-band answer suggestions

For every question with a substantive learner answer, preserve the original answer and produce a revised spoken answer at a length appropriate to its part:

- Part 1: normally 2–4 natural sentences (roughly 20–40 words), with a direct answer and brief reason or detail.
- Part 2: a coherent long turn designed for roughly 90–120 seconds (often about 170–240 words at a natural pace) when the transcript provides enough personal evidence.
- Part 3: normally 4–7 developed sentences (roughly 60–120 words), using a claim plus explanation, example, comparison, condition, or qualification as appropriate.

These are practice targets, not official per-answer scoring thresholds. Do not pad an answer or infer a band from word count.

If the learner's answer is too thin, add safe model development: reasoning implied by the learner's view, general consequences, comparisons, or explicitly general/hypothetical examples. Never invent a personal event, person, place, date, school, job, achievement, relationship, trip, or preference. When Part 2 lacks enough personal evidence, produce the fullest safe version and state that the learner needs to add true details.

Prefer precise collocations, natural phrasal verbs, and flexible sentence patterns. Use idiomatic language only when it fits naturally; never force slang or conspicuous memorised phrases. In `changes`, identify material added by the model and mark anything the learner should verify or replace with `示范补充，请按真实情况调整`.

## 8. Pronunciation and delivery

Only provide pronunciation feedback when audio evidence is available. From text alone, write `Not assessed from text`.

## 9. One recommended retraining target

Return exactly:

- `Target`
- `Why this target`
- `Success behavior`
- `Next drill`

Choose one behavior the learner can demonstrate, not a broad goal such as “improve vocabulary”.

This recommendation is saved for later selection. Do not assume that the learner's next session must retrain it; the learner may continue the same question, move to the next question, or choose any historical session.

## 10. Updated learner record

Return a compact machine-readable JSON block:

```json
{
  "session_id": "YYYY-MM-DD-NNN",
  "focus_part": "Part 3",
  "priority_target": {
    "id": "logic-explain-example",
    "label": "Add a reason and example after the main claim",
    "status": "new",
    "evidence": ["learner quote"]
  },
  "must_correct": [],
  "naturalness": [],
  "vocabulary": [],
  "habits": []
}
```
