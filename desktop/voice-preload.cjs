const { contextBridge, ipcRenderer } = require('electron')

let mediaRecorder
let microphoneStream
let activeSessionId = ''
let startedAt = 0
let pendingChunks = []

function preferredMimeType() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return options.find((type) => globalThis.MediaRecorder?.isTypeSupported?.(type)) || ''
}

async function sendChunk(blob) {
  if (!blob?.size || !activeSessionId) return
  const bytes = new Uint8Array(await blob.arrayBuffer())
  ipcRenderer.send('ielts:recording-chunk', { sessionId: activeSessionId, bytes })
}

contextBridge.exposeInMainWorld('ieltsAudioRecorder', {
  start: async (sessionId) => {
    if (mediaRecorder?.state === 'recording') return { ok: true, alreadyRecording: true }
    activeSessionId = String(sessionId || '')
    if (!activeSessionId) throw new Error('缺少训练记录 ID。')
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    })
    const mimeType = preferredMimeType()
    await ipcRenderer.invoke('ielts:recording-begin', { sessionId: activeSessionId, mimeType: mimeType || 'audio/webm' })
    pendingChunks = []
    mediaRecorder = mimeType ? new MediaRecorder(microphoneStream, { mimeType }) : new MediaRecorder(microphoneStream)
    mediaRecorder.addEventListener('dataavailable', (event) => {
      const pending = sendChunk(event.data)
      pendingChunks.push(pending)
    })
    startedAt = Date.now()
    mediaRecorder.start(1000)
    return { ok: true, mimeType: mediaRecorder.mimeType || mimeType || 'audio/webm' }
  },
  stop: async () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return { ok: false, reason: 'not-recording' }
    const sessionId = activeSessionId
    const durationMs = Math.max(0, Date.now() - startedAt)
    await new Promise((resolve) => {
      mediaRecorder.addEventListener('stop', resolve, { once: true })
      mediaRecorder.stop()
    })
    await Promise.allSettled(pendingChunks)
    microphoneStream?.getTracks().forEach((track) => track.stop())
    const result = await ipcRenderer.invoke('ielts:recording-finish', { sessionId, durationMs })
    mediaRecorder = undefined
    microphoneStream = undefined
    activeSessionId = ''
    pendingChunks = []
    return result
  },
  cancel: async () => {
    const sessionId = activeSessionId
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    microphoneStream?.getTracks().forEach((track) => track.stop())
    mediaRecorder = undefined
    microphoneStream = undefined
    activeSessionId = ''
    pendingChunks = []
    return ipcRenderer.invoke('ielts:recording-cancel', { sessionId })
  }
})
