import { app, BrowserWindow, clipboard, ipcMain, session as electronSession, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { findExistingReview, findReviewAfterRequest, parseReview } from './review-parser.mjs'
import { ChatGPTAdapter } from './chatgpt-adapter.mjs'
import { answerUpgradeGuidance } from './answer-upgrade-policy.mjs'
import { advanceVoiceEndMonitor } from './voice-end-policy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const dashboardUrl = 'http://127.0.0.1:43127/'
const chatgptUrl = 'https://chatgpt.com/'
const chatPartition = 'persist:ielts-speaking-chatgpt'
let recordingsDir
const pageComposerLocator = `(() => {
  const selector = '#prompt-textarea, textarea, [contenteditable], [role="textbox"], [placeholder], [aria-label], [aria-placeholder], [data-placeholder]';
  const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 80 && rect.height > 12 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const score = (element) => {
    const attributes = [element.id, element.getAttribute('placeholder'), element.getAttribute('aria-label'), element.getAttribute('aria-placeholder'), element.getAttribute('data-placeholder')].filter(Boolean).join(' ').toLowerCase();
    let value = 0;
    if (element.id === 'prompt-textarea') value += 200;
    if (/问问\\s*chatgpt|询问\\s*chatgpt|message\\s*chatgpt|chatgpt/.test(attributes)) value += 160;
    if (element.isContentEditable || element.hasAttribute('contenteditable')) value += 40;
    if (element.matches('textarea, input, [role="textbox"]')) value += 25;
    return value;
  };
  return [...document.querySelectorAll(selector)].filter(visible).map((element) => ({ element, score: score(element) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score)[0]?.element;
})()`

let dashboardWindow
let chatWindow
let chatAdapter
let checkpointTimer
let checkpointPromise = Promise.resolve()
let activeSession
let capturedTurns = []
let finalizationPromise
let voiceEndMonitorId = 0
let microphoneRecordingActive = false
const recordingFiles = new Map()
let state = { phase: 'idle', message: '桌面训练助手已就绪', voiceActive: false, recordingActive: false, transcriptCount: 0 }

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function withTimeout(promise, timeout, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout)
    })
  ]).finally(() => clearTimeout(timer))
}

function publish(next) {
  state = { ...state, ...next }
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('ielts:status', state)
}

async function dashboardReady() {
  try {
    const response = await fetch('http://127.0.0.1:43127/api/health')
    return response.ok
  } catch {
    return false
  }
}

async function ensureDashboard() {
  if (await dashboardReady()) return
  process.env.IELTS_SPEAKING_EMBEDDED = '1'
  await import('../mcp/server.mjs')
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await dashboardReady()) return
    await pause(250)
  }
  throw new Error('本地仪表盘启动超时。')
}

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 760,
    title: 'IELTS Speaking Coach',
    backgroundColor: '#f5f3fb',
    webPreferences: {
      preload: path.join(__dirname, 'dashboard-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  dashboardWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  void dashboardWindow.loadURL(dashboardUrl)
  dashboardWindow.on('closed', () => { dashboardWindow = undefined })
}

function configureMediaPermission() {
  const ses = electronSession.fromPartition(chatPartition)
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return permission === 'media' && requestingOrigin.startsWith('https://chatgpt.com')
  })
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = permission === 'media' && webContents.getURL().startsWith('https://chatgpt.com')
    callback(allowed)
  })
}

function ensureChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) return chatWindow
  chatWindow = new BrowserWindow({
    width: 1180,
    height: 900,
    show: false,
    title: 'ChatGPT Voice · IELTS Speaking Coach',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: chatPartition,
      preload: path.join(__dirname, 'voice-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  chatWindow.on('closed', () => {
    voiceEndMonitorId += 1
    chatWindow = undefined
    void saveCheckpoint()
    stopCapture()
    microphoneRecordingActive = false
    if (activeSession?.id) void cancelRecordingFile(activeSession.id)
    if (activeSession) publish({ phase: 'interrupted', message: 'ChatGPT窗口已关闭；本次记录尚未完成。', voiceActive: false })
  })
  return chatWindow
}

function recordingExtension(mimeType = '') {
  return mimeType.includes('ogg') ? '.ogg' : '.webm'
}

async function beginRecordingFile({ sessionId, mimeType }) {
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safeId) throw new Error('录音记录 ID 无效。')
  await fs.mkdir(recordingsDir, { recursive: true })
  const filePath = path.join(recordingsDir, `${safeId}-${Date.now()}${recordingExtension(mimeType)}`)
  await fs.writeFile(filePath, Buffer.alloc(0))
  recordingFiles.set(safeId, { filePath, mimeType: String(mimeType || 'audio/webm'), pending: Promise.resolve() })
  return { ok: true, filePath }
}

function appendRecordingChunk({ sessionId, bytes }) {
  const recording = recordingFiles.get(String(sessionId || ''))
  if (!recording || !bytes) return
  const chunk = Buffer.from(bytes)
  recording.pending = recording.pending.then(() => fs.appendFile(recording.filePath, chunk)).catch((error) => {
    publish({ phase: 'capture-warning', message: `录音写入失败：${error.message}`, recordingActive: false })
  })
}

async function finishRecordingFile({ sessionId, durationMs }) {
  const safeId = String(sessionId || '')
  const recording = recordingFiles.get(safeId)
  if (!recording) return { ok: false, reason: 'recording-file-missing' }
  await recording.pending
  const containerFixed = await makeRecordingSeekable(recording.filePath)
  const stat = await fs.stat(recording.filePath)
  recordingFiles.delete(safeId)
  return { ok: true, sessionId: safeId, filePath: recording.filePath, mimeType: recording.mimeType, size: stat.size, durationMs: Number(durationMs) || 0, containerFixed }
}

async function makeRecordingSeekable(filePath) {
  const temporaryPath = `${filePath}.seekable.webm`
  const completed = await new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    const child = spawn('ffmpeg', ['-y', '-v', 'error', '-i', filePath, '-c:a', 'copy', temporaryPath], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); finish(false) }, 30_000)
    child.once('error', () => { clearTimeout(timer); finish(false) })
    child.once('close', (code) => { clearTimeout(timer); finish(code === 0) })
  })
  if (!completed) {
    await fs.unlink(temporaryPath).catch(() => {})
    return false
  }
  try {
    const result = await fs.stat(temporaryPath)
    if (!result.size) throw new Error('empty-remux-output')
    await fs.copyFile(temporaryPath, filePath)
    await fs.unlink(temporaryPath)
    return true
  } catch {
    await fs.unlink(temporaryPath).catch(() => {})
    return false
  }
}

async function cancelRecordingFile(sessionId) {
  const safeId = String(sessionId || '')
  const recording = recordingFiles.get(safeId)
  if (!recording) return { ok: true }
  await recording.pending.catch(() => {})
  await fs.unlink(recording.filePath).catch(() => {})
  recordingFiles.delete(safeId)
  return { ok: true }
}

async function startMicrophoneRecording(sessionId) {
  const dashboard = await fetch('http://127.0.0.1:43127/api/dashboard').then((response) => response.json())
  if (!dashboard.recordingEnabled) return { ok: false, disabled: true }
  try {
    const result = await chatWindow.webContents.executeJavaScript(`window.ieltsAudioRecorder?.start(${JSON.stringify(sessionId)})`, true)
    microphoneRecordingActive = Boolean(result?.ok)
    if (microphoneRecordingActive) publish({ recordingActive: true, message: '训练进行中；正在本地录制你的麦克风回答。' })
    return result || { ok: false }
  } catch (error) {
    microphoneRecordingActive = false
    publish({ phase: 'capture-warning', message: `Voice可以继续，但麦克风录音未启动：${error.message}`, recordingActive: false })
    return { ok: false, error: error.message }
  }
}

async function stopMicrophoneRecording() {
  if (!microphoneRecordingActive || !chatWindow || chatWindow.isDestroyed()) return { ok: false, disabled: true }
  try {
    const result = await chatWindow.webContents.executeJavaScript('window.ieltsAudioRecorder?.stop()', true)
    microphoneRecordingActive = false
    publish({ recordingActive: false })
    if (!result?.ok || !result.filePath || !activeSession?.id) return result || { ok: false }
    const response = await fetch('http://127.0.0.1:43127/api/desktop/session-recording', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeSession.id, filePath: result.filePath, mimeType: result.mimeType, size: result.size, durationMs: result.durationMs })
    })
    if (!response.ok) throw new Error((await response.json()).error || '录音没有挂到训练记录。')
    return { ...result, attached: true }
  } catch (error) {
    microphoneRecordingActive = false
    publish({ phase: 'capture-warning', message: `训练文字已保存，但录音收尾失败：${error.message}`, recordingActive: false })
    return { ok: false, error: error.message }
  }
}

async function waitForComposer(timeout = 90_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (!chatWindow || chatWindow.isDestroyed()) return false
    const ready = await chatWindow.webContents.executeJavaScript(`Boolean(${pageComposerLocator})`, true).catch(() => false)
    if (ready) return true
    await pause(500)
  }
  return false
}

async function waitForSentUserTurn(previousUserCount, confirmationText, timeout = 8_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const rows = chatAdapter ? await chatAdapter.snapshot() : await readTurns()
    mergeTurns(rows)
    const userTurns = rows.filter((row) => row.role === 'user')
    const newest = userTurns.at(-1)?.text || ''
    if (userTurns.length > previousUserCount && (!confirmationText || newest.includes(confirmationText))) return true
    await pause(350)
  }
  return false
}

async function replaceComposerText(prompt) {
  const focused = await chatWindow.webContents.executeJavaScript(`(() => {
    const input = ${pageComposerLocator};
    if (!input) return false;
    input.focus();
    return true;
  })()`, true)
  if (!focused) return false
  const expected = String(prompt).replace(/\s+/g, ' ').trim()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    chatWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    chatWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    chatWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'BACKSPACE' })
    chatWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'BACKSPACE' })
    await pause(250)
    chatWindow.webContents.insertText(prompt)
    await pause(800)
    const actual = await chatWindow.webContents.executeJavaScript(`(() => {
      const input = ${pageComposerLocator};
      return input instanceof HTMLTextAreaElement ? input.value : (input?.innerText || input?.textContent || '');
    })()`, true).catch(() => '')
    if (String(actual).replace(/\s+/g, ' ').trim() === expected) return true
  }
  return false
}

async function clickComposerSendDirect() {
  return chatWindow.webContents.executeJavaScript(`(() => {
    const composer = ${pageComposerLocator};
    if (!composer) return false;
    const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none'; };
    const composerRect = composer.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('button:not([disabled])')].filter(visible);
    const sendSelector = 'button[data-testid*="send"], button[aria-label*="Send"], button[aria-label*="发送"], button[title*="Send"], button[title*="发送"]';
    const explicit = buttons.find((button) => button.matches(sendSelector));
    if (explicit) { explicit.click(); return true; }
    const candidate = buttons
      .filter((button) => !/microphone|麦克风|voice|语音|audio|音频/i.test(button.getAttribute('aria-label') || button.getAttribute('title') || button.getAttribute('data-testid') || ''))
      .map((button) => ({ button, rect: button.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left >= composerRect.left + composerRect.width * 0.55 && rect.right <= composerRect.right + 48 && rect.top >= composerRect.top - 48 && rect.bottom <= composerRect.bottom + 64)
      .sort((a, b) => (Math.abs(a.rect.right - composerRect.right) + Math.abs(a.rect.bottom - composerRect.bottom)) - (Math.abs(b.rect.right - composerRect.right) + Math.abs(b.rect.bottom - composerRect.bottom)))[0];
    if (!candidate) return false;
    candidate.button.click();
    return true;
  })()`, true).catch(() => false)
}

async function trustedClickSendButton(timeout = 6_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const point = await chatWindow.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"][role="textbox"]');
      if (!input) return null;
      const inputRect = input.getBoundingClientRect();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width >= 24 && rect.height >= 24 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const buttons = [...document.querySelectorAll('button:not([disabled])')].filter(visible);
      const labelled = buttons.find((button) => /send|发送/i.test([button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid')].filter(Boolean).join(' ')));
      const nearby = buttons.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left > inputRect.left + inputRect.width * 0.65 && rect.top < inputRect.bottom + 45 && rect.bottom > inputRect.top - 20;
      }).sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
      const button = labelled || nearby;
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      const candidates = [
        [0.5, 0.5], [0.3, 0.5], [0.25, 0.3], [0.25, 0.7], [0.65, 0.35]
      ];
      for (const [rx, ry] of candidates) {
        const x = Math.round(rect.left + rect.width * rx);
        const y = Math.round(rect.top + rect.height * ry);
        const top = document.elementFromPoint(x, y);
        if (top && (top === button || button.contains(top))) return { x, y };
      }
      return null;
    })()`, true).catch(() => null)
    if (point) {
      chatWindow.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      chatWindow.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      return true
    }
    await pause(300)
  }
  return false
}

async function submitComposerWithEnter() {
  const focused = await chatWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"][role="textbox"]');
    if (!input) return false;
    input.focus();
    const selection = window.getSelection?.();
    if (selection && input.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return document.activeElement === input || input.contains(document.activeElement);
  })()`, true).catch(() => false)
  if (!focused) return false
  await pause(150)
  chatWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  chatWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  return true
}

async function submitComposerForm() {
  return chatWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"][role="textbox"]');
    const form = input?.closest('form');
    if (!form) return false;
    const buttons = [...form.querySelectorAll('button:not([disabled])')];
    const send = buttons.find((button) => /send|发送/i.test([button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid')].filter(Boolean).join(' ')));
    try { form.requestSubmit(send || undefined); return true; } catch { return false; }
  })()`, true).catch(() => false)
}

async function activateSendButtonWithKeyboard() {
  const focused = await chatWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"][role="textbox"]');
    const form = input?.closest('form');
    if (!form) return false;
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width >= 24 && rect.height >= 24 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const buttons = [...form.querySelectorAll('button:not([disabled])')].filter(visible);
    const labelled = buttons.find((button) => /send|发送/i.test([
      button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid'), button.getAttribute('type')
    ].filter(Boolean).join(' ')));
    const inputRect = input.getBoundingClientRect();
    const nearestRight = buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid')].filter(Boolean).join(' ');
        return !/attach|upload|microphone|dictat|voice|附件|上传|麦克风|语音/i.test(label)
          && rect.left > inputRect.left + inputRect.width * 0.65;
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
    const button = labelled || nearestRight;
    if (!button) return false;
    button.focus();
    return document.activeElement === button;
  })()`, true).catch(() => false)
  if (!focused) return false
  await pause(150)
  chatWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  chatWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  return true
}

async function submitComposerWithDevToolsEnter() {
  const focused = await chatWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"][role="textbox"]');
    input?.focus();
    return Boolean(input);
  })()`, true).catch(() => false)
  if (!focused) return false
  const debug = chatWindow.webContents.debugger
  let attachedHere = false
  try {
    if (!debug.isAttached()) { debug.attach('1.3'); attachedHere = true }
    const common = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await debug.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
    await debug.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', ...common })
    await debug.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    return true
  } catch {
    return false
  } finally {
    if (attachedHere && debug.isAttached()) debug.detach()
  }
}

async function sendPrompt(prompt, confirmationText = '') {
  if (!(await waitForComposer())) throw new Error('没有找到ChatGPT输入框。请先在弹出的窗口登录ChatGPT。')
  const beforeRows = chatAdapter ? await chatAdapter.snapshot() : await readTurns()
  const previousUserCount = beforeRows.filter((row) => row.role === 'user').length
  const inserted = await replaceComposerText(prompt)
  if (!inserted) throw new Error('指令没有成功写入ChatGPT输入框，请重试。')
  if (await clickComposerSendDirect() && await waitForSentUserTurn(previousUserCount, confirmationText, 6_000)) return
  if (await submitComposerWithEnter() && await waitForSentUserTurn(previousUserCount, confirmationText, 5_000)) return
  if (await activateSendButtonWithKeyboard() && await waitForSentUserTurn(previousUserCount, confirmationText, 6_000)) return
  if (await submitComposerWithDevToolsEnter() && await waitForSentUserTurn(previousUserCount, confirmationText, 6_000)) return
  if (await submitComposerForm() && await waitForSentUserTurn(previousUserCount, confirmationText, 5_000)) return
  if (await trustedClickSendButton() && await waitForSentUserTurn(previousUserCount, confirmationText, 10_000)) return
  throw new Error('指令仍停留在ChatGPT输入框中，没有真正发送；工具已停止启动Voice。')
}

async function readTurns(timeout = 8_000) {
  if (!chatWindow || chatWindow.isDestroyed()) return []
  return withTimeout(chatWindow.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('[data-message-author-role]')];
    return rows.map((row) => ({
      role: row.getAttribute('data-message-author-role') === 'assistant' ? 'assistant' : 'user',
      text: (row.innerText || row.textContent || '').trim()
    })).filter((row) => row.text);
  })()`, true), timeout, '读取ChatGPT对话超时').catch(() => [])
}

function mergeTurns(rows) {
  const byId = new Map(capturedTurns.map((row, index) => [row.sourceMessageId || `legacy-${index}`, row]))
  for (const [index, row] of rows.entries()) {
    const key = row.sourceMessageId || `turn-${index}`
    byId.set(key, { ...byId.get(key), ...row, sourceMessageId: key, capturedAt: row.capturedAt || new Date().toISOString() })
  }
  capturedTurns = [...byId.values()].slice(-200)
  publish({ transcriptCount: capturedTurns.length })
}

function isTrainingSetupTurn(turn) {
  return turn?.role === 'user' && String(turn?.text || '').trim().startsWith('你现在是雅思口语考官。请直接开始一次')
}

function transcriptForSession(turns = [], session = activeSession) {
  if (!session) return []
  const reference = String(session.selectedReference || '').trim()
  const setupMarker = '你现在是雅思口语考官。请直接开始一次'
  const normalizedTurns = turns.map((turn) => {
    if (turn?.role !== 'user' || isTrainingSetupTurn(turn)) return turn
    const text = String(turn?.text || '')
    const embeddedIndex = text.lastIndexOf(setupMarker)
    if (embeddedIndex < 0) return turn
    const embeddedSetup = text.slice(embeddedIndex).trim()
    return reference && embeddedSetup.includes(reference) ? { ...turn, text: embeddedSetup } : turn
  })
  const setupIndexes = normalizedTurns.map((turn, index) => ({ turn, index })).filter(({ turn }) => isTrainingSetupTurn(turn))
  const matchingSetup = [...setupIndexes].reverse().find(({ turn }) => !reference || String(turn.text).includes(reference))
  if (!matchingSetup) return []
  let end = normalizedTurns.length
  for (let index = matchingSetup.index + 1; index < normalizedTurns.length; index += 1) {
    const text = String(normalizedTurns[index]?.text || '')
    if (isTrainingSetupTurn(normalizedTurns[index]) || (normalizedTurns[index]?.role === 'user' && /SYNC_REQUEST_ID:|<<<IELTS_REVIEW_JSON:/i.test(text))) {
      end = index
      break
    }
  }
  return normalizedTurns.slice(matchingSetup.index, end).map((turn) => ({ ...turn }))
}

async function saveCheckpoint() {
  if (!activeSession?.id || !capturedTurns.length) return
  const sessionId = activeSession.id
  const transcript = transcriptForSession(capturedTurns, activeSession)
  if (!transcript.length) {
    publish({ phase: 'capture-warning', message: '当前ChatGPT对话与本次训练题目不匹配，已阻止写入，避免混入其他训练。' })
    return
  }
  const chatUrl = chatWindow && !chatWindow.isDestroyed() ? chatWindow.webContents.getURL() : activeSession.chatUrl || ''
  checkpointPromise = checkpointPromise.then(async () => {
    const response = await fetch('http://127.0.0.1:43127/api/desktop/session-checkpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, transcript, chatUrl })
    })
    if (!response.ok) throw new Error((await response.json()).error || '训练记录实时保存失败。')
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('ielts:data-updated', { kind: 'transcript-checkpoint', sessionId, transcriptCount: transcript.length })
    }
  }).catch((error) => {
    publish({ phase: 'capture-warning', message: `已捕获对话，但本地实时保存失败：${error.message}` })
  })
  return checkpointPromise
}

function scheduleCheckpoint() {
  if (checkpointTimer) clearTimeout(checkpointTimer)
  checkpointTimer = setTimeout(() => { checkpointTimer = undefined; void saveCheckpoint() }, 450)
}

function handleTranscriptEvent(event) {
  mergeTurns([event])
  scheduleCheckpoint()
}

async function startCapture() {
  stopCapture()
  chatAdapter = new ChatGPTAdapter(chatWindow.webContents, {
    onEvent: handleTranscriptEvent,
    onUnsupported: () => publish({ phase: 'capture-warning', message: 'ChatGPT页面结构已变化，实时捕获暂停；请保留当前窗口。' })
  })
  return chatAdapter.start()
}

function stopCapture() {
  if (checkpointTimer) clearTimeout(checkpointTimer)
  checkpointTimer = undefined
  chatAdapter?.stop()
  chatAdapter = undefined
}

async function waitForAssistantReply(previousCount, timeout = 90_000) {
  const started = Date.now()
  let lastText = ''
  let stable = 0
  while (Date.now() - started < timeout) {
    const rows = chatAdapter ? await chatAdapter.snapshot() : await readTurns()
    mergeTurns(rows)
    const assistants = rows.filter((row) => row.role === 'assistant')
    const newest = assistants.at(-1)?.text || ''
    if (assistants.length > previousCount && newest) {
      if (newest === lastText) stable += 1
      else stable = 0
      lastText = newest
      if (stable >= 3) return newest
    }
    await pause(700)
  }
  throw new Error('等待ChatGPT回复超时。')
}

async function chatIsGenerating() {
  if (!chatWindow || chatWindow.isDestroyed()) return false
  return chatWindow.webContents.executeJavaScript(`Boolean(document.querySelector('button[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="停止"]'))`, true).catch(() => false)
}

async function waitForConversationSettled(timeout = 45_000) {
  const started = Date.now()
  let lastSignature = ''
  let stable = 0
  while (Date.now() - started < timeout) {
    const rows = chatAdapter ? await chatAdapter.snapshot() : await readTurns()
    mergeTurns(rows)
    const newest = rows.at(-1)
    const signature = newest ? `${newest.role}\0${newest.text}` : ''
    stable = signature && signature === lastSignature ? stable + 1 : 0
    lastSignature = signature
    const generating = await chatIsGenerating()
    if (newest?.role === 'assistant' && !generating && stable >= 3) return rows
    await pause(700)
  }
  throw new Error('ChatGPT仍在处理结束训练的回复，请保持窗口打开后重新同步。')
}

function assistantTextAfterRequest(turns, requestId) {
  const requestIndex = turns.findLastIndex((turn) => turn?.role === 'user' && String(turn?.text || '').includes(requestId))
  if (requestIndex < 0) return ''
  return turns.slice(requestIndex + 1).filter((turn) => turn?.role === 'assistant' && turn.text).map((turn) => turn.text).join('\n')
}

async function waitForReview(requestId, timeout = 105_000) {
  const started = Date.now()
  let lastAssistantText = ''
  let stableInvalidReply = 0
  while (Date.now() - started < timeout) {
    const rows = chatAdapter ? await chatAdapter.snapshot() : await readTurns()
    mergeTurns(rows)
    const requirements = { requireAnswerUpgrades: true }
    const found = findReviewAfterRequest(rows, requestId, requirements) || findReviewAfterRequest(capturedTurns, requestId, requirements)
    if (found) return found
    const assistantText = assistantTextAfterRequest(rows, requestId) || assistantTextAfterRequest(capturedTurns, requestId)
    if (assistantText && assistantText === lastAssistantText && !(await chatIsGenerating())) stableInvalidReply += 1
    else stableInvalidReply = 0
    lastAssistantText = assistantText
    if (stableInvalidReply >= 7) {
      const error = new Error('ChatGPT本次回复没有包含标准复盘JSON。')
      error.code = 'INVALID_REVIEW_REPLY'
      throw error
    }
    await pause(700)
  }
  const error = new Error('ChatGPT复盘生成超时。')
  error.code = 'REVIEW_TIMEOUT'
  throw error
}

async function clickVoiceButton() {
  return chatWindow.webContents.executeJavaScript(`(() => new Promise((resolve) => {
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 15 && rect.height > 15; };
    const buttons = [...document.querySelectorAll('button:not([disabled])')].filter(visible);
    const label = (item) => [item.getAttribute('aria-label'), item.getAttribute('title'), item.getAttribute('data-testid')].filter(Boolean).join(' ');
    const button = buttons.find((item) => /voice|语音/i.test(label(item)) && !/end|leave|exit|结束|退出/i.test(label(item)));
    if (!button) return resolve(false);
    button.click();
    const deadline = Date.now() + 12_000;
    const confirm = () => {
      const endVisible = [...document.querySelectorAll('button:not([disabled])')].filter(visible).some((item) => /end voice|leave voice|exit voice|end conversation|结束语音|退出语音|结束对话/i.test(label(item)));
      if (!button.isConnected || !visible(button) || endVisible) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(confirm, 150);
    };
    confirm();
  }))()`, true).catch(() => false)
}

async function stopVoiceButton() {
  return chatWindow.webContents.executeJavaScript(`(() => {
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 15 && rect.height > 15; };
    const buttons = [...document.querySelectorAll('button:not([disabled])')].filter(visible);
    const button = buttons.find((item) => /end voice|leave voice|exit voice|end conversation|结束语音|退出语音|结束对话/i.test([item.getAttribute('aria-label'), item.getAttribute('title'), item.getAttribute('data-testid')].filter(Boolean).join(' ')));
    if (!button) return false;
    button.click(); return true;
  })()`, true).catch(() => false)
}

async function readVoiceLifecycle() {
  if (!chatWindow || chatWindow.isDestroyed()) return { active: false, ended: false, composer: false }
  return chatWindow.webContents.executeJavaScript(`(() => {
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 15 && rect.height > 15; };
    const roots = [document];
    const labels = [];
    const textParts = [];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      const rootBody = root.body || root.host;
      if (rootBody) textParts.push(String(rootBody.innerText || rootBody.textContent || ''));
      [...root.querySelectorAll('button')].filter(visible).forEach((item) => {
        labels.push([item.getAttribute('aria-label'), item.getAttribute('title'), item.getAttribute('data-testid'), item.innerText].filter(Boolean).join(' '));
      });
      for (const item of root.querySelectorAll('*')) {
        if (item.shadowRoot && !roots.includes(item.shadowRoot)) roots.push(item.shadowRoot);
        if (item.tagName === 'IFRAME') {
          try { if (item.contentDocument && !roots.includes(item.contentDocument)) roots.push(item.contentDocument); } catch {}
        }
      }
    }
    const pageText = textParts.join(' ').replace(/\\s+/g, '').toLowerCase();
    const active = labels.some((label) => /end voice|leave voice|exit voice|end conversation|结束语音|退出语音|结束对话/i.test(label));
    return {
      active,
      voiceSurface: active || labels.some((label) => /mute|unmute|microphone|voice|静音|麦克风|语音/i.test(label)),
      ended: /voicechat(has)?ended|voiceconversation(has)?ended|语音聊天已结束|语音对话已结束/i.test(pageText),
      composer: Boolean(${pageComposerLocator})
    };
  })()`, true).catch(() => ({ active: false, voiceSurface: false, ended: false, composer: false }))
}

function startVoiceEndMonitor() {
  const monitorId = ++voiceEndMonitorId
  void (async () => {
    let monitorState = {}
    const started = Date.now()
    while (monitorId === voiceEndMonitorId && activeSession) {
      const lifecycle = await readVoiceLifecycle()
      monitorState = advanceVoiceEndMonitor(monitorState, lifecycle, {
        elapsedMs: Date.now() - started,
        busy: Boolean(finalizationPromise)
      })
      if (monitorState.shouldFinalize) {
        voiceEndMonitorId += 1
        void prepareReviewAfterVoiceEnd().catch(() => undefined)
        return
      }
      await pause(1_000)
    }
  })()
}

function trainingPrompt(session) {
  const plannedCount = Array.isArray(session.questionIds) ? session.questionIds.length : 0
  const isPlanSelection = Boolean(session.planItemId)
  const duration = isPlanSelection
    ? `完成本次从今日计划中勾选的${plannedCount}个题目`
    : ({ quick: '约5分钟', standard: '约10分钟', full: '完成所选Part的完整模拟' }[session.length] || '约10分钟')
  const batchRule = isPlanSelection && plannedCount > 1 ? '\n6. 只按本次勾选的题目清单从上到下训练；完成一个后再进入下一个。' : ''
  return `你现在是雅思口语考官。请直接开始一次${session.part}模拟训练。\n\n本次题目：\n${session.selectedReference || '按照当前题库继续'}\n训练范围：${duration}\n本次单一目标：${session.singleGoal || '完成自然、连贯且具体的回答'}\n\n规则：\n1. 全程用英语提问。\n2. 一次只问一个问题，等待我完整回答。\n3. 不要在训练中纠错、评分、表扬或解释。\n4. Part 1简短自然；Part 2给出准备和陈述流程；Part 3根据我的回答追问，不要与回答脱节。\n5. 我说“结束训练”时立即结束考官模式，先回复“本次训练已结束”，等待下一条复盘指令。${batchRule}\n\n请先说第一道题，不要介绍规则。`
}

function reviewPrompt(requestId, practiceTranscript = [], retry = false, part = '') {
  const transcript = practiceTranscript
    .filter((turn) => ['assistant', 'user'].includes(turn?.role) && turn.text && !isTrainingSetupTurn(turn))
    .map((turn) => ({ role: turn.role, text: String(turn.text) }))
  const transcriptInstruction = transcript.length
    ? `\n\n下面的TRAINING_TRANSCRIPT是桌面工具实时保存的本次完整训练记录，也是唯一事实来源。即使当前聊天窗口没有之前的上下文，也必须根据它完成复盘：\n<TRAINING_TRANSCRIPT>\n${JSON.stringify(transcript)}\n</TRAINING_TRANSCRIPT>`
    : ''
  const retryInstruction = `${retry ? '上一条回复格式错误。不要重复上一条回复，现在必须输出完整JSON。' : ''}answer_upgrades必须是JSON数组，即使只有一题也必须使用[...]；必须为每一道得到考生实质回答的问题逐题生成，数量与有实质回答的问题数量一致。只有问候或没有实质回答的问题不要生成。`
  return `这是桌面工具发出的雅思口语复盘分析指令，不是“结束训练”口令。你现在不再扮演口语考官，不要继续提问，也绝对不要回复“本次训练已结束”。${retryInstruction}\n请只根据下方训练问答中考生真实说过的话生成标准化复盘。不要分析考官的话，不要虚构发音判断。纠错与评价必须以原话为证据；逐题高分版可依照下方规则做安全、透明的示范性展开。\n\n${answerUpgradeGuidance(part)}\n\n输出必须严格为下面两个标记包住的一段JSON，不要输出Markdown代码块或其他文字。同步编号必须原样保留。\n[SYNC_REQUEST_ID:${requestId}]\n<<<IELTS_REVIEW_JSON:${requestId}>>>\n{"sync_request_id":"${requestId}","summary":"中文总结","focus_part":"Part 1|Part 2|Part 3","must_correct":[{"original":"考生原话","improved":"正确表达","reason":"中文原因"}],"natural_upgrades":[{"original":"考生原话","improved":"更自然表达","reason":"中文原因"}],"repeated_habits":[{"original":"重复词或口头习惯","improved":"替换或训练建议","reason":"出现情况"}],"logic_feedback":[{"original":"回答中的逻辑问题","improved":"更好的展开结构","reason":"中文说明"}],"vocabulary_upgrades":[{"original":"考生使用的普通词","improved":"可自然替换的词或搭配","reason":"适用语境"}],"answer_upgrades":[{"question":"考官实际提出的问题","original_answer":"考生针对该题的完整英文原回答，必须忠实转录","revised_answer":"保留原立场和个人事实，并按所属Part适度补足后的完整英文口语答案","changes":["中文说明纠错、表达升级和示范补充；需核实的补充要明确提醒"]}],"priority_target":{"id":"英文短ID","description":"下一次可选的唯一复训目标","status":"new"},"next_target":"下一次可选目标"}\n<<<END_IELTS_REVIEW_JSON:${requestId}>>>\nanswer_upgrades必须按训练问答中的实际问题逐题生成。没有实质回答的问题不要生成。其他某一类没有足够证据时返回空数组。${transcriptInstruction}`
}

function practiceTurnsOnly(turns = []) {
  const reviewBoundary = turns.findIndex((turn) => turn?.role === 'user' && /SYNC_REQUEST_ID:|<<<IELTS_REVIEW_JSON:/i.test(String(turn?.text || '')))
  return (reviewBoundary >= 0 ? turns.slice(0, reviewBoundary) : turns).map((turn) => ({ ...turn }))
}

async function generateReview(practiceTranscript, replyTimeout = 105_000, part = activeSession?.part) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestId = `sync-${randomUUID()}`
    publish({
      phase: attempt === 0 ? 'reviewing' : 'review-retrying',
      message: attempt === 0 ? '正在生成标准化复盘…' : '第一次回复格式不完整，正在自动补发复盘请求（最后一次）…',
      voiceActive: false
    })
    await sendPrompt(reviewPrompt(requestId, practiceTranscript, attempt > 0, part), requestId)
    try {
      return await waitForReview(requestId, attempt === 0 ? replyTimeout : Math.min(replyTimeout, 90_000))
    } catch (error) {
      lastError = error
      if (attempt === 0 && ['INVALID_REVIEW_REPLY', 'REVIEW_TIMEOUT'].includes(error.code)) {
        await waitForConversationSettled(30_000).catch(() => undefined)
        continue
      }
      throw error
    }
  }
  throw lastError || new Error('ChatGPT没有生成可识别的复盘报告。')
}

function pendingReviewPath(sessionId) {
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '')
  return path.join(app.getPath('userData'), 'pending-reviews', `${safeId}.json`)
}

async function writePendingReview(payload) {
  const filePath = pendingReviewPath(payload.sessionId)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify({ ...payload, queuedAt: new Date().toISOString() }, null, 2), 'utf8')
  await fs.rename(temporaryPath, filePath)
}

async function readPendingReview(sessionId) {
  try {
    return JSON.parse(await fs.readFile(pendingReviewPath(sessionId), 'utf8'))
  } catch {
    return undefined
  }
}

async function removePendingReview(sessionId) {
  await fs.unlink(pendingReviewPath(sessionId)).catch(() => {})
}

async function saveCompletion(report, rawReport, transcript) {
  const response = await withTimeout(fetch('http://127.0.0.1:43127/api/desktop/session-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: activeSession.id, transcript, report, rawReport })
  }), 10_000, '保存复盘超时，请稍后重试。')
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '本地复盘保存失败。')
  return result
}

async function commitCompletion(report, rawReport, transcript, source = 'chatgpt') {
  await writePendingReview({ sessionId: activeSession.id, report, rawReport, transcript, source })
  publish({ phase: 'saving', message: '复盘已识别，正在同步训练记录、问题档案和词汇…' })
  let saved
  try {
    saved = await saveCompletion(report, rawReport, transcript)
  } catch (error) {
    publish({ phase: 'sync-error', message: `复盘已安全缓存在本地，但写入档案失败：${error.message}`, voiceActive: false })
    throw error
  }
  await removePendingReview(activeSession.id)
  stopCapture()
  activeSession = undefined
  publish({ phase: 'complete', message: '复盘、训练记录、问题档案和词汇已同步。', voiceActive: false })
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('ielts:data-updated', {
      sessionId: saved.sessionId,
      updated: ['report', 'sessions', 'issues', 'vocabulary', 'targets']
    })
  }
  return { ok: true, source, saved, report, status: state }
}

async function startTraining(session) {
  if (finalizationPromise) throw new Error('复盘仍在同步，请等待完成后再开始下一次训练。')
  if (!session?.id) throw new Error('请先在仪表盘中保存一道训练题。')
  activeSession = session
  voiceEndMonitorId += 1
  capturedTurns = []
  publish({ phase: 'opening', message: '正在打开ChatGPT…', voiceActive: false, transcriptCount: 0 })
  const window = ensureChatWindow()
  window.show()
  await window.loadURL(chatgptUrl)
  if (!(await waitForComposer(45_000))) {
    publish({ phase: 'login-required', message: '请先在ChatGPT窗口登录；登录后回到仪表盘再次点击启动。', voiceActive: false })
    return { ok: false, needsLogin: true, status: state }
  }
  publish({ phase: 'prompting', message: '正在发送本次雅思训练设置…' })
  const assistantCount = (await readTurns()).filter((row) => row.role === 'assistant').length
  await startCapture()
  await sendPrompt(trainingPrompt(session), '你现在是雅思口语考官')
  await waitForAssistantReply(assistantCount)
  activeSession = { ...activeSession, chatUrl: chatWindow.webContents.getURL() }
  await saveCheckpoint()
  publish({ phase: 'starting-voice', message: '考官已准备，正在启动Voice…' })
  await startMicrophoneRecording(session.id)
  const voiceStarted = await clickVoiceButton()
  if (!voiceStarted) {
    publish({ phase: 'voice-manual', message: '题目已发送，但没有找到Voice按钮。请在ChatGPT窗口手动点击语音图标。', voiceActive: false })
    startVoiceEndMonitor()
    return { ok: true, voiceStarted: false, status: state }
  }
  publish({ phase: 'training', message: '训练进行中；手动结束Voice后，工具会自动生成复盘。', voiceActive: true })
  startVoiceEndMonitor()
  return { ok: true, voiceStarted: true, status: state }
}

async function runPrepareReviewAfterVoiceEnd() {
  if (!activeSession) throw new Error('当前没有正在进行的训练。')
  publish({ phase: 'voice-ended', message: '已识别到语音聊天结束，正在整理完整对话…', voiceActive: false })
  await stopMicrophoneRecording()
  await waitForConversationSettled()
  mergeTurns(chatAdapter ? await chatAdapter.snapshot() : await readTurns())
  await saveCheckpoint()
  let practiceTranscript = transcriptForSession(capturedTurns, activeSession)
  if (!practiceTranscript.some((turn) => turn.role === 'user')) throw new Error('当前页面没有读取到考生回答')
  const existing = findExistingReview(practiceTranscript, { requireAnswerUpgrades: true })
  let generated
  if (existing) {
    practiceTranscript = practiceTranscript.slice(0, existing.index)
    generated = { report: existing.report, rawReport: existing.rawReport }
  } else {
    generated = await generateReview(practiceTranscript, 120_000)
  }
  await writePendingReview({
    sessionId: activeSession.id,
    report: generated.report,
    rawReport: generated.rawReport,
    transcript: practiceTranscript,
    source: existing ? 'existing-chat-report' : 'auto-generated-after-voice'
  })
  stopCapture()
  publish({
    phase: 'review-ready',
    message: '复盘已在 ChatGPT 中生成并缓存在本地。请点击“同步复盘报告”。',
    voiceActive: false,
    recordingActive: false
  })
  return { ok: true, readyToSync: true, status: state }
}

function prepareReviewAfterVoiceEnd() {
  if (finalizationPromise) return finalizationPromise
  finalizationPromise = runPrepareReviewAfterVoiceEnd().catch((error) => {
    publish({ phase: 'sync-error', message: `语音已结束，但自动生成复盘失败：${error.message}。可点击“补生成复盘报告”。`, voiceActive: false })
    throw error
  }).finally(() => { finalizationPromise = undefined })
  return finalizationPromise
}

async function runFinalization({ voiceAlreadyEnded = false, replyTimeout = 120_000 } = {}) {
  if (!activeSession) throw new Error('当前没有正在进行的训练。')
  publish({ phase: 'ending-voice', message: '正在整理完整对话…' })
  if (!voiceAlreadyEnded) await stopVoiceButton()
  await pause(1800)
  await stopMicrophoneRecording()
  publish({ phase: 'waiting-end', message: '正在等待ChatGPT确认训练结束…', voiceActive: false })
  await waitForConversationSettled()
  mergeTurns(chatAdapter ? await chatAdapter.snapshot() : await readTurns())
  await saveCheckpoint()
  let practiceTranscript = transcriptForSession(capturedTurns, activeSession)
  if (!practiceTranscript.some((turn) => turn.role === 'user')) throw new Error('当前页面没有读取到考生回答')
  publish({ phase: 'reviewing', message: '正在读取当前对话并生成标准化复盘…', voiceActive: false })
  const existing = findExistingReview(practiceTranscript, { requireAnswerUpgrades: true })
  let rawReport
  let report
  if (existing) {
    rawReport = existing.rawReport
    report = existing.report
    practiceTranscript = practiceTranscript.slice(0, existing.index)
    if (/复盘|报告|review|json/i.test(practiceTranscript.at(-1)?.text || '')) practiceTranscript.pop()
  } else {
    const generated = await generateReview(practiceTranscript, replyTimeout)
    rawReport = generated.rawReport
    report = generated.report
  }
  return commitCompletion(report, rawReport, practiceTranscript, existing ? 'existing-chat-report' : 'generated-chat-report')
}

function finalizeTraining(options = {}) {
  voiceEndMonitorId += 1
  if (finalizationPromise) return finalizationPromise
  finalizationPromise = runFinalization(options).catch((error) => {
    publish({ phase: 'sync-error', message: error.message || '复盘同步失败；训练记录已保存在本地，可重试。', voiceActive: false })
    throw error
  }).finally(() => { finalizationPromise = undefined })
  return finalizationPromise
}

function syncGeneratedReview() {
  if (finalizationPromise) return finalizationPromise
  finalizationPromise = syncCurrentGeneratedReview().catch((error) => {
    publish({ phase: 'sync-error', message: error.message || '复盘同步失败；训练记录已保存在本地，可重试。', voiceActive: false })
    throw error
  }).finally(() => { finalizationPromise = undefined })
  return finalizationPromise
}

async function loadRecoverableSession() {
  const response = await withTimeout(
    fetch('http://127.0.0.1:43127/api/dashboard'),
    5_000,
    '读取本地训练记录超时，请关闭重复打开的应用后重试。'
  )
  const dashboard = await response.json()
  const session = dashboard.sessions?.find((item) => item.status === 'active')
    || (dashboard.currentSession?.status !== 'completed' ? dashboard.currentSession : undefined)
    || dashboard.sessions?.find((item) => item.status === 'planned')
  if (!session?.id) {
    publish({ phase: 'recovery-needed', message: '仪表盘里没有待完成的训练，请先保存一次选题。' })
    throw new Error('仪表盘里没有待完成的训练')
  }
  return session
}

async function syncCurrentGeneratedReview() {
  publish({ phase: 'checking-session', message: '正在确认待同步的复盘…', voiceActive: false })
  const session = await loadRecoverableSession()
  activeSession = session
  const pending = await readPendingReview(session.id)
  if (pending?.report) {
    publish({ phase: 'reading-pending', message: '发现本地待同步复盘，正在继续保存…', voiceActive: false })
    return commitCompletion(pending.report, pending.rawReport || '', pending.transcript || session.transcript || [], 'pending-local-review')
  }
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (session.chatUrl && chatWindow.webContents.getURL() !== session.chatUrl) {
      publish({ phase: 'reading-current', message: '正在打开本次训练绑定的ChatGPT对话…', voiceActive: false })
      await chatWindow.loadURL(session.chatUrl)
      await waitForComposer(45_000)
    }
    publish({ phase: 'reading-current', message: '正在读取 ChatGPT 中已生成的复盘…', voiceActive: false })
    const currentTranscript = await readTurns(6_000)
    const existing = findExistingReview(currentTranscript, { requireAnswerUpgrades: true })
    if (existing) {
      let practiceTranscript = currentTranscript.slice(0, existing.index)
      if (/复盘|报告|review|json/i.test(practiceTranscript.at(-1)?.text || '')) practiceTranscript.pop()
      return commitCompletion(existing.report, existing.rawReport, practiceTranscript, 'current-chat-window')
    }
  }
  publish({ phase: 'reading-clipboard', message: '当前对话未识别到完整报告，正在检查剪贴板…', voiceActive: false })
  const copiedReport = clipboard.readText().trim()
  if (copiedReport) {
    try {
      const report = parseReview(copiedReport, { requireAnswerUpgrades: true })
      return commitCompletion(report, copiedReport, [], 'clipboard')
    } catch {}
  }
  publish({ phase: 'recovery-needed', message: '没有找到已生成的复盘。请点击“补生成复盘报告”。', voiceActive: false })
  throw new Error('没有找到已生成的复盘，请先补生成')
}

async function generateMissingCurrentReview() {
  publish({ phase: 'checking-session', message: '正在读取本地训练记录…', voiceActive: false })
  const session = await loadRecoverableSession()
  activeSession = session
  const pending = await readPendingReview(session.id)
  if (pending?.report) {
    publish({ phase: 'review-ready', message: '复盘已生成，请点击“同步复盘报告”。', voiceActive: false })
    return { ok: true, readyToSync: true, alreadyGenerated: true }
  }

  const lifecycle = chatWindow && !chatWindow.isDestroyed() ? await readVoiceLifecycle() : { active: false }
  if (lifecycle.active) throw new Error('请先在 ChatGPT 中结束 Voice，再补生成复盘。')
  const currentTranscript = chatWindow && !chatWindow.isDestroyed() ? await readTurns(6_000) : []
  const existing = findExistingReview(currentTranscript, { requireAnswerUpgrades: true })
  if (existing) {
    let practiceTranscript = currentTranscript.slice(0, existing.index)
    if (/复盘|报告|review|json/i.test(practiceTranscript.at(-1)?.text || '')) practiceTranscript.pop()
    await writePendingReview({ sessionId: session.id, report: existing.report, rawReport: existing.rawReport, transcript: practiceTranscript, source: 'existing-chat-report' })
    publish({ phase: 'review-ready', message: '已找到完整复盘，请点击“同步复盘报告”。', voiceActive: false })
    return { ok: true, readyToSync: true, alreadyGenerated: true }
  }

  const currentSessionTranscript = transcriptForSession(currentTranscript, session)
  const localSessionTranscript = transcriptForSession(session.transcript || [], session)
  const savedTranscript = currentSessionTranscript.length ? currentSessionTranscript : localSessionTranscript
  const hasLearnerAnswer = savedTranscript.some((turn) => turn.role === 'user' && !isTrainingSetupTurn(turn) && String(turn.text || '').trim())
  if (!hasLearnerAnswer) throw new Error('本地没有保存到可用的考生回答，暂时无法补生成。')

  publish({ phase: 'review-retrying', message: '自动生成未触发，正在根据本地对话补生成复盘…', voiceActive: false })
  const hadChatWindow = Boolean(chatWindow && !chatWindow.isDestroyed())
  const window = ensureChatWindow()
  window.show()
  if (!hadChatWindow || (!currentSessionTranscript.length && localSessionTranscript.length)) {
    publish({ phase: 'review-retrying', message: '当前窗口不是本次训练，正在新建独立复盘对话并显示生成过程…', voiceActive: false })
    await window.loadURL(chatgptUrl)
  }
  if (!(await waitForComposer(45_000))) throw new Error('请先在 ChatGPT 窗口登录，然后再次点击补生成。')
  stopCapture()
  capturedTurns = []
  const generated = await generateReview(savedTranscript, 105_000, session.part)
  await writePendingReview({ sessionId: session.id, report: generated.report, rawReport: generated.rawReport, transcript: savedTranscript, source: 'regenerated-from-local-transcript' })
  publish({ phase: 'review-ready', message: '复盘已补生成，请点击“同步复盘报告”。', voiceActive: false })
  return { ok: true, readyToSync: true, alreadyGenerated: false }
}

function generateMissingReview() {
  if (finalizationPromise) return finalizationPromise
  finalizationPromise = generateMissingCurrentReview().catch((error) => {
    publish({ phase: 'sync-error', message: error.message || '复盘补生成失败；本地训练记录已保留。', voiceActive: false })
    throw error
  }).finally(() => { finalizationPromise = undefined })
  return finalizationPromise
}

async function runRegenerateAnswerUpgrades(sessionId) {
  const requestedId = String(sessionId || '').trim()
  if (!requestedId) throw new Error('复盘记录 ID 无效。')
  if (activeSession && ['training', 'voice-manual', 'ending-voice', 'waiting-end', 'reviewing'].includes(state.phase)) {
    throw new Error('请先完成当前 Voice 训练，再补生成历史回答建议。')
  }
  publish({ phase: 'checking-session', message: '正在读取这份复盘的本地训练记录…', voiceActive: false })
  const response = await withTimeout(fetch('http://127.0.0.1:43127/api/dashboard'), 5_000, '读取本地复盘超时。')
  const dashboard = await response.json()
  const session = dashboard.sessions?.find((item) => item.id === requestedId && item.status === 'completed')
  if (!session) throw new Error('找不到对应的已完成复盘。')
  const transcript = practiceTurnsOnly(session.transcript || [])
  const hasLearnerAnswer = transcript.some((turn) => turn.role === 'user' && !isTrainingSetupTurn(turn) && String(turn.text || '').trim())
  if (!hasLearnerAnswer) throw new Error('这份复盘没有保存可用的考生回答，无法忠实补生成建议。')

  publish({ phase: 'repairing-review', message: '正在根据本地完整对话重新生成回答建议…', voiceActive: false })
  const window = ensureChatWindow()
  window.show()
  await window.loadURL(chatgptUrl)
  if (!(await waitForComposer(45_000))) throw new Error('请先在 ChatGPT 窗口登录，然后再次点击重新生成。')
  stopCapture()
  capturedTurns = []
  const generated = await generateReview(transcript, 120_000, session.part)
  const answerUpgrades = generated.report?.answer_upgrades
  if (!Array.isArray(answerUpgrades) || !answerUpgrades.length) throw new Error('ChatGPT 未返回完整的回答建议。')
  const saveResponse = await withTimeout(fetch('http://127.0.0.1:43127/api/report/answer-upgrades', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: requestedId, answerUpgrades })
  }), 10_000, '保存回答建议超时。')
  const saved = await saveResponse.json()
  if (!saveResponse.ok) throw new Error(saved.error || '回答建议保存失败。')
  publish({ phase: 'complete', message: '回答建议已重新生成并保存。', voiceActive: false })
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('ielts:data-updated', { kind: 'answer-upgrades-repaired', sessionId: requestedId })
  }
  return { ok: true, sessionId: requestedId, answerUpgradeCount: answerUpgrades.length }
}

function regenerateAnswerUpgrades(sessionId) {
  if (finalizationPromise) throw new Error('另一份复盘正在处理，请等待完成。')
  finalizationPromise = runRegenerateAnswerUpgrades(sessionId).catch((error) => {
    publish({ phase: 'sync-error', message: error.message || '回答建议重新生成失败。', voiceActive: false })
    throw error
  }).finally(() => { finalizationPromise = undefined })
  return finalizationPromise
}

const singleInstanceLock = app.requestSingleInstanceLock()

if (!singleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) createDashboardWindow()
    if (dashboardWindow.isMinimized()) dashboardWindow.restore()
    dashboardWindow.show()
    dashboardWindow.focus()
  })

  app.whenReady().then(async () => {
  const dataRoot = process.env.IELTS_SPEAKING_DATA_DIR
    ? path.resolve(process.env.IELTS_SPEAKING_DATA_DIR)
    : process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'IELTS Speaking Coach')
      : app.getPath('userData')
  process.env.IELTS_SPEAKING_DATA_DIR = dataRoot
  recordingsDir = path.join(dataRoot, 'recordings')
  configureMediaPermission()
  await ensureDashboard()
  createDashboardWindow()
  ipcMain.handle('ielts:get-status', () => state)
  ipcMain.handle('ielts:recording-begin', (_event, payload) => beginRecordingFile(payload))
  ipcMain.on('ielts:recording-chunk', (_event, payload) => appendRecordingChunk(payload))
  ipcMain.handle('ielts:recording-finish', (_event, payload) => finishRecordingFile(payload))
  ipcMain.handle('ielts:recording-cancel', (_event, payload) => cancelRecordingFile(payload?.sessionId))
  ipcMain.handle('ielts:open-chatgpt', async () => { const window = ensureChatWindow(); window.show(); if (!window.webContents.getURL()) await window.loadURL(chatgptUrl); return { ok: true } })
  ipcMain.handle('ielts:start-training', (_event, session) => startTraining(session))
  ipcMain.handle('ielts:sync-generated-review', () => syncGeneratedReview())
  ipcMain.handle('ielts:generate-missing-review', () => generateMissingReview())
  ipcMain.handle('ielts:recover-review', () => syncGeneratedReview())
  ipcMain.handle('ielts:stop-training', () => generateMissingReview())
  ipcMain.handle('ielts:regenerate-answer-upgrades', (_event, sessionId) => regenerateAnswerUpgrades(sessionId))
  app.on('activate', () => { if (!dashboardWindow) createDashboardWindow() })
  }).catch((error) => {
    console.error(error)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  void saveCheckpoint()
  stopCapture()
  if (process.platform !== 'darwin') app.quit()
})
