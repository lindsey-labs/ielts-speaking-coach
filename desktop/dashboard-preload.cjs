const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ieltsDesktop', {
  startTraining: (session) => ipcRenderer.invoke('ielts:start-training', session),
  syncGeneratedReview: () => ipcRenderer.invoke('ielts:sync-generated-review'),
  generateMissingReview: () => ipcRenderer.invoke('ielts:generate-missing-review'),
  stopTraining: () => ipcRenderer.invoke('ielts:generate-missing-review'),
  recoverReview: () => ipcRenderer.invoke('ielts:sync-generated-review'),
  regenerateAnswerUpgrades: (sessionId) => ipcRenderer.invoke('ielts:regenerate-answer-upgrades', sessionId),
  openChatGPT: () => ipcRenderer.invoke('ielts:open-chatgpt'),
  getStatus: () => ipcRenderer.invoke('ielts:get-status'),
  onStatus: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('ielts:status', handler)
    return () => ipcRenderer.removeListener('ielts:status', handler)
  },
  onDataUpdated: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('ielts:data-updated', handler)
    return () => ipcRenderer.removeListener('ielts:data-updated', handler)
  }
})
