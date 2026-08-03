import { jsonrepair } from 'jsonrepair'

function looksLikeReview(value) {
  return Boolean(value && typeof value === 'object' && (
    Array.isArray(value.must_correct) ||
    Array.isArray(value.natural_upgrades) ||
    Array.isArray(value.logic_feedback) ||
    value.priority_target
  ))
}

function normalizeReview(value) {
  if (!value || typeof value !== 'object') return value
  const answerUpgrades = value.answer_upgrades
  if (answerUpgrades === undefined) return value
  return {
    ...value,
    answer_upgrades: Array.isArray(answerUpgrades)
      ? answerUpgrades
      : (answerUpgrades && typeof answerUpgrades === 'object' ? [answerUpgrades] : [])
  }
}

function satisfiesRequirements(value, { requireAnswerUpgrades = false } = {}) {
  if (!looksLikeReview(value)) return false
  if (!requireAnswerUpgrades) return true
  return Array.isArray(value.answer_upgrades) && value.answer_upgrades.some((item) => (
    item && typeof item === 'object' &&
    String(item.original_answer || '').trim() &&
    String(item.revised_answer || '').trim()
  ))
}

export function parseReview(text, options = {}) {
  const source = String(text || '').trim()
  const candidates = []
  const marked = source.match(/<<<(?:IELTS_REVIEW_JSON|START_OF_JSON|JSON)(?::[a-z0-9-]+)?>>>([\s\S]*?)<<<(?:END_IELTS_REVIEW_JSON|END_OF_JSON|END_JSON)(?::[a-z0-9-]+)?>>>/i)
  if (marked?.[1]) candidates.push(marked[1].trim())
  candidates.push(source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim())
  const firstBrace = source.indexOf('{')
  const lastBrace = source.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(source.slice(firstBrace, lastBrace + 1))

  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = normalizeReview(JSON.parse(candidate))
      if (satisfiesRequirements(parsed, options)) return parsed
    } catch {}
    try {
      const repaired = normalizeReview(JSON.parse(jsonrepair(candidate)))
      if (satisfiesRequirements(repaired, options)) return repaired
    } catch {}
  }
  throw new Error(options.requireAnswerUpgrades
    ? 'ChatGPT已经回复，但复盘缺少完整的回答建议'
    : 'ChatGPT已经回复，但没有返回可识别的标准复盘JSON')
}

export function findReviewAfterRequest(turns = [], requestId = '', options = {}) {
  const token = String(requestId || '').trim()
  if (!token) return undefined
  let requestIndex = -1
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === 'user' && String(turns[index]?.text || '').includes(token)) {
      requestIndex = index
      break
    }
  }
  if (requestIndex < 0) return undefined

  const assistantTurns = turns
    .map((turn, index) => ({ ...turn, index }))
    .filter((turn) => turn.index > requestIndex && turn.role === 'assistant' && turn.text)

  for (let offset = assistantTurns.length - 1; offset >= 0; offset -= 1) {
    const turn = assistantTurns[offset]
    try {
      return { index: turn.index, rawReport: turn.text, report: parseReview(turn.text, options) }
    } catch {}
  }

  if (assistantTurns.length > 1) {
    const rawReport = assistantTurns.map((turn) => turn.text).join('\n')
    try {
      return { index: assistantTurns[0].index, rawReport, report: parseReview(rawReport, options) }
    } catch {}
  }
  return undefined
}

export function findExistingReview(turns = [], options = {}) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn?.role !== 'assistant') continue
    try {
      return { index, rawReport: turn.text, report: parseReview(turn.text, options) }
    } catch {}
  }
  return undefined
}
