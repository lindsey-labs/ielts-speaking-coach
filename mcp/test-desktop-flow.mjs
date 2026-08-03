import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ielts-speaking-desktop-test-'))
const port = '43128'
const base = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, [path.join(root, 'mcp', 'server.mjs'), '--dashboard-only'], {
  cwd: root,
  env: { ...process.env, IELTS_SPEAKING_DATA_DIR: dataDir, IELTS_SPEAKING_DASHBOARD_PORT: port },
  stdio: 'ignore',
  windowsHide: true,
})

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Test dashboard did not start.')
}

try {
  await waitForHealth()
  const initialDashboard = await (await fetch(`${base}/api/dashboard`)).json()
  const availableQuestions = initialDashboard.questions || []
  const profileResponse = await fetch(`${base}/api/profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: '  Sample Learner  ' })
  })
  const profileResult = await profileResponse.json()
  if (!profileResponse.ok || profileResult.learner?.displayName !== 'Sample Learner') throw new Error('Learner display name was not normalized and saved.')
  const invalidProfileResponse = await fetch(`${base}/api/profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: '   ' })
  })
  if (invalidProfileResponse.ok) throw new Error('Blank learner display name was accepted.')
  const profileDashboard = await (await fetch(`${base}/api/dashboard`)).json()
  if (profileDashboard.learner?.displayName !== 'Sample Learner') throw new Error('Learner display name was not returned by dashboard API.')
  const settingsResponse = await fetch(`${base}/api/settings/recording`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true })
  })
  if (!settingsResponse.ok) throw new Error('Recording opt-in setting was not saved.')
  const settingsDashboard = await (await fetch(`${base}/api/dashboard`)).json()
  if (!settingsDashboard.recordingEnabled) throw new Error('Recording opt-in setting was not returned by dashboard API.')
  const part3PlanResponse = await fetch(`${base}/api/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lengthDays: 7, weeklyTarget: 5, focus: 'Part 3' })
  })
  const part3Planned = await part3PlanResponse.json()
  if (!part3PlanResponse.ok) throw new Error(part3Planned.error)
  const part3QuestionIds = part3Planned.plan?.items?.flatMap((item) => item.questionIds || []) || []
  const part3BatchSizes = part3Planned.plan?.items?.map((item) => item.questionCount) || []
  const availablePart3Count = availableQuestions.filter((item) => item.part === 'Part 3').length
  const expectedPart3Days = Math.min(5, availablePart3Count)
  if (part3QuestionIds.length !== availablePart3Count || new Set(part3QuestionIds).size !== availablePart3Count) throw new Error('7-day Part 3 plan did not cover all available topics exactly once.')
  if (part3Planned.plan.items.length !== expectedPart3Days || Math.max(...part3BatchSizes) - Math.min(...part3BatchSizes) > 1) throw new Error('Part 3 topics were not distributed evenly across the available training days.')
  const planResponse = await fetch(`${base}/api/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lengthDays: 14, weeklyTarget: 5, focus: 'balanced' })
  })
  const planned = await planResponse.json()
  if (!planResponse.ok) throw new Error(planned.error)
  const expectedBalancedDays = Math.min(10, availableQuestions.length)
  if (planned.plan?.lengthDays !== 14 || planned.plan?.items?.length !== expectedBalancedDays) throw new Error('14-day practice plan was not generated correctly.')
  const allQuestionIds = planned.plan.items.flatMap((item) => item.questionIds || [])
  if (allQuestionIds.length !== availableQuestions.length || new Set(allQuestionIds).size !== availableQuestions.length) throw new Error('Balanced plan did not cover all available bank topics exactly once.')
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (planned.plan.items[0]?.date !== todayKey) throw new Error('Practice plan did not start on the local calendar date.')
  const firstDayQuestionIds = planned.plan.items[0].questionIds || []
  if (firstDayQuestionIds.length < 2) throw new Error('Test bank must provide at least two questions on the first training day.')
  const partialQuestionCount = Math.min(2, firstDayQuestionIds.length - 1)
  const selectionResponse = await fetch(`${base}/api/training-selection`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      route: 'choose_question', part: planned.plan.items[0].part, length: 'full',
      questionId: planned.plan.items[0].questionIds[0], planItemId: planned.plan.items[0].id,
      questionIds: firstDayQuestionIds.slice(0, partialQuestionCount),
      singleGoal: 'complete the planned question bundle'
    })
  })
  const selection = await selectionResponse.json()
  if (!selectionResponse.ok) throw new Error(selection.error)
  if (selection.session.questionIds?.length !== partialQuestionCount) throw new Error('Selected plan subset was not preserved in the session.')
  const checkpointTranscript = [
    { sourceMessageId: 'turn-1', role: 'assistant', text: 'Should schools teach financial skills?', status: 'complete' },
    { sourceMessageId: 'turn-2', role: 'user', text: 'I think it let students to make better decisions.', status: 'complete' },
  ]
  const checkpointResponse = await fetch(`${base}/api/desktop/session-checkpoint`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: selection.session.id, transcript: checkpointTranscript })
  })
  const checkpoint = await checkpointResponse.json()
  if (!checkpointResponse.ok) throw new Error(checkpoint.error)
  const checkpointDashboard = await (await fetch(`${base}/api/dashboard`)).json()
  if (checkpointDashboard.currentSession?.status !== 'active') throw new Error('Session checkpoint was not activated.')
  if (checkpointDashboard.currentSession?.transcript?.length !== 2) throw new Error('Transcript checkpoint was not saved.')
  const recordingDir = path.join(dataDir, 'recordings')
  const recordingPath = path.join(recordingDir, `${selection.session.id}.webm`)
  const recordingBytes = Buffer.from([26, 69, 223, 163, 1, 2, 3, 4, 5, 6])
  await fs.mkdir(recordingDir, { recursive: true })
  await fs.writeFile(recordingPath, recordingBytes)
  const attachRecordingResponse = await fetch(`${base}/api/desktop/session-recording`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: selection.session.id, filePath: recordingPath, mimeType: 'audio/webm', size: recordingBytes.length, durationMs: 2400 })
  })
  if (!attachRecordingResponse.ok) throw new Error('Session recording was not attached.')
  const rangeResponse = await fetch(`${base}/api/recordings/${encodeURIComponent(selection.session.id)}`, { headers: { Range: 'bytes=2-5' } })
  if (rangeResponse.status !== 206 || (await rangeResponse.arrayBuffer()).byteLength !== 4) throw new Error('Recording byte-range playback endpoint failed.')
  const review = {
    summary: '回答有明确观点，但表达和展开需要改进。', focus_part: 'Part 3',
    must_correct: [{ original: 'let students to make', improved: 'allow students to make', reason: 'let后接动词原形。' }],
    natural_upgrades: [], repeated_habits: [{ original: 'I think', improved: '直接陈述观点', reason: '避免机械开头。' }],
    logic_feedback: [{ original: '只有观点', improved: '补充原因和例子', reason: '需要展开。' }],
    vocabulary_upgrades: [{ original: 'better decisions', improved: 'make informed decisions', reason: '更自然的搭配。' }],
    answer_upgrades: [{ question: 'Should schools teach financial skills?', original_answer: 'I think it let students to make better decisions.', revised_answer: 'I think schools should teach financial skills because this can allow students to make better decisions.', changes: ['修正let的用法', '补充完整因果连接'] }],
    priority_target: { id: 'reason-example', description: '观点后补充原因和例子', status: 'new' }
  }
  const incompleteResponse = await fetch(`${base}/api/desktop/session-complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: selection.session.id, report: { summary: '不完整复盘', must_correct: review.must_correct } })
  })
  const incomplete = await incompleteResponse.json()
  if (incompleteResponse.ok || !/缺少完整的回答建议/.test(incomplete.error || '')) throw new Error('Incomplete review with a learner answer was accepted.')
  const completionPayload = { sessionId: selection.session.id, report: review }
  const completeResponse = await fetch(`${base}/api/desktop/session-complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(completionPayload)
  })
  const completed = await completeResponse.json()
  if (!completeResponse.ok) throw new Error(completed.error)
  const dashboard = await (await fetch(`${base}/api/dashboard`)).json()
  if (dashboard.plan?.items?.length !== expectedBalancedDays) throw new Error('Practice plan was not returned by dashboard API.')
  if (dashboard.plan.items[0]?.status !== 'planned') throw new Error('Partial plan session incorrectly completed the whole training day.')
  if (dashboard.plan.items[0]?.completedQuestionIds?.length !== partialQuestionCount) throw new Error('Partial plan question progress was not saved.')
  if (dashboard.sessions[0]?.status !== 'completed') throw new Error('Session was not completed.')
  if (dashboard.issues.length < 3) throw new Error('Issue index was not populated.')
  if (dashboard.vocabulary[0]?.term !== 'make informed decisions') throw new Error('Vocabulary index was not populated.')
  if (dashboard.sessions[0]?.report?.answer_upgrades?.[0]?.revised_answer !== review.answer_upgrades[0].revised_answer) throw new Error('Improved full answer was not saved with the review.')
  if (!completed.markdownPath || !completed.jsonPath) throw new Error('Review files were not created.')
  if (dashboard.sessions[0]?.transcript?.length !== 2) throw new Error('Completion did not reuse the saved checkpoint transcript.')
  if (dashboard.sessions[0]?.recording?.durationMs !== 2400) throw new Error('Attached recording was not retained after completion.')
  const repeatResponse = await fetch(`${base}/api/desktop/session-complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(completionPayload)
  })
  const repeated = await repeatResponse.json()
  if (!repeatResponse.ok) throw new Error(repeated.error)
  const dashboardAfterRepeat = await (await fetch(`${base}/api/dashboard`)).json()
  if (!repeated.alreadySaved) throw new Error('Repeated report was not recognized as already saved.')
  if (dashboardAfterRepeat.issues.length !== dashboard.issues.length) throw new Error('Repeated report duplicated issue indexes.')
  if (dashboardAfterRepeat.vocabulary.length !== dashboard.vocabulary.length) throw new Error('Repeated report duplicated vocabulary indexes.')
  const revisedAnswer = 'Schools should teach financial skills because this can help students make informed decisions.'
  const upgradeResponse = await fetch(`${base}/api/report/answer-upgrades`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: selection.session.id, answerUpgrades: [{ question: 'Should schools teach financial skills?', original_answer: 'I think it let students to make better decisions.', revised_answer: revisedAnswer, changes: ['修正语法并保留原观点'] }] })
  })
  const upgraded = await upgradeResponse.json()
  if (!upgradeResponse.ok) throw new Error(upgraded.error)
  const dashboardAfterUpgrade = await (await fetch(`${base}/api/dashboard`)).json()
  if (dashboardAfterUpgrade.sessions[0]?.report?.answer_upgrades?.[0]?.revised_answer !== revisedAnswer) throw new Error('Answer suggestion backfill was not saved.')
  if (dashboardAfterUpgrade.issues.length !== dashboardAfterRepeat.issues.length) throw new Error('Answer suggestion backfill changed issue statistics.')
  const deleteRecordingResponse = await fetch(`${base}/api/recordings/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: selection.session.id })
  })
  if (!deleteRecordingResponse.ok) throw new Error('Recording delete endpoint failed.')
  const dashboardAfterDelete = await (await fetch(`${base}/api/dashboard`)).json()
  if (dashboardAfterDelete.sessions[0]?.recording) throw new Error('Deleted recording metadata remained in the session.')
  try { await fs.stat(recordingPath); throw new Error('Deleted recording file remained on disk.') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const remainingQuestionIds = firstDayQuestionIds.slice(partialQuestionCount)
  const remainingSelectionResponse = await fetch(`${base}/api/training-selection`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ route: 'choose_question', part: planned.plan.items[0].part, length: 'full', planItemId: planned.plan.items[0].id, questionIds: remainingQuestionIds })
  })
  const remainingSelection = await remainingSelectionResponse.json()
  if (!remainingSelectionResponse.ok) throw new Error(remainingSelection.error)
  const remainingCompletionResponse = await fetch(`${base}/api/desktop/session-complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: remainingSelection.session.id, report: { summary: '剩余计划题目已完成。' } })
  })
  if (!remainingCompletionResponse.ok) throw new Error('Remaining plan question completion failed.')
  const dashboardAfterPlanCompletion = await (await fetch(`${base}/api/dashboard`)).json()
  if (dashboardAfterPlanCompletion.plan.items[0]?.status !== 'completed') throw new Error('Training day was not completed after all question subsets finished.')
  if (dashboardAfterPlanCompletion.plan.items[0]?.completedQuestionIds?.length !== planned.plan.items[0].questionIds.length) throw new Error('Final per-question plan progress is incomplete.')
  process.stdout.write(`Desktop flow test passed. Checkpoint: ${checkpoint.transcriptCount}; issues: ${dashboard.issues.length}; vocabulary: ${dashboard.vocabulary.length}\n`)
} finally {
  child.kill()
}
