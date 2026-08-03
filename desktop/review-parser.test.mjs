import assert from 'node:assert/strict'
import { findExistingReview, findReviewAfterRequest, parseReview } from './review-parser.mjs'

const review = { summary: 'ok', must_correct: [], natural_upgrades: [], logic_feedback: [], answer_upgrades: [{ question: 'Why?', original_answer: 'Because it is useful.', revised_answer: 'I believe it is useful because it helps me work more efficiently.', changes: ['补全句子结构'] }], priority_target: { id: 'expand' } }
const json = JSON.stringify(review)
assert.deepEqual(parseReview(`<<<IELTS_REVIEW_JSON>>>\n${json}\n<<<END_IELTS_REVIEW_JSON>>>`), review)
assert.deepEqual(parseReview(`<<<START_OF_JSON>>>\n${json}\n<<<END_OF_JSON>>>`), review)
assert.deepEqual(parseReview(`<<<IELTS_REVIEW_JSON:sync-123>>>\n${json}\n<<<END_IELTS_REVIEW_JSON:sync-123>>>`), review)
assert.deepEqual(parseReview(`报告如下：\n${json}\n请查收。`), review)
const singleUpgradeObject = { ...review, answer_upgrades: review.answer_upgrades[0] }
assert.deepEqual(parseReview(JSON.stringify(singleUpgradeObject)).answer_upgrades, review.answer_upgrades)
assert.deepEqual(parseReview(`{'summary':'ok','must_correct':[],'priority_target':{'id':'expand'},}`), { summary: 'ok', must_correct: [], priority_target: { id: 'expand' } })
assert.equal(findExistingReview([{ role: 'user', text: 'answer' }, { role: 'assistant', text: `<<<JSON>>>${json}<<<END_JSON>>>` }])?.index, 1)
assert.equal(findReviewAfterRequest([
  { role: 'assistant', text: 'old reply' },
  { role: 'user', text: 'generate report [SYNC_REQUEST_ID:sync-123]' },
  { role: 'assistant', text: '本次训练已结束' },
  { role: 'assistant', text: '<<<IELTS_REVIEW_JSON:sync-123>>>' },
  { role: 'assistant', text: json },
  { role: 'assistant', text: '<<<END_IELTS_REVIEW_JSON:sync-123>>>' }
], 'sync-123')?.report.summary, 'ok')
assert.equal(findReviewAfterRequest([{ role: 'user', text: 'another request' }, { role: 'assistant', text: json }], 'sync-123'), undefined)
assert.throws(() => parseReview('普通聊天回复'))
assert.throws(
  () => parseReview(JSON.stringify({ summary: 'incomplete', must_correct: [], priority_target: { id: 'expand' } }), { requireAnswerUpgrades: true }),
  /缺少完整的回答建议/
)
assert.deepEqual(parseReview(json, { requireAnswerUpgrades: true }), review)
assert.equal(findReviewAfterRequest([
  { role: 'user', text: 'generate report [SYNC_REQUEST_ID:sync-incomplete]' },
  { role: 'assistant', text: JSON.stringify({ summary: 'incomplete', must_correct: [] }) }
], 'sync-incomplete', { requireAnswerUpgrades: true }), undefined)
process.stdout.write('Review parser tests passed.\n')
