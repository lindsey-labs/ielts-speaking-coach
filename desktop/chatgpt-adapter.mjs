const observerScript = `(() => {
  if (window.__ieltsCoachDrain) return true;
  const queue = [];
  const seen = new Map();
  const visibleText = (node) => (node?.innerText || node?.textContent || '').trim();
  const read = (emit) => {
    const articles = [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')];
    const nodes = articles.length ? articles : [...document.querySelectorAll('[data-message-author-role]')];
    nodes.forEach((node, index) => {
      const attributed = node.matches?.('[data-message-author-role]') ? node : node.querySelector('[data-message-author-role]');
      const rawRole = attributed?.getAttribute('data-message-author-role');
      if (!['assistant', 'user'].includes(rawRole)) return;
      const text = visibleText(node);
      if (!text) return;
      const sourceMessageId = node.getAttribute('data-message-id') || attributed?.getAttribute('data-message-id') || node.id || 'turn-' + index;
      const generating = Boolean(document.querySelector('button[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="停止"]'));
      const status = rawRole === 'assistant' && generating ? 'streaming' : 'complete';
      const signature = status + '\\0' + text;
      if (seen.get(sourceMessageId) === signature) return;
      seen.set(sourceMessageId, signature);
      if (emit) queue.push({ sourceMessageId, role: rawRole, text, status });
    });
  };
  const observer = new MutationObserver(() => read(true));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  read(false);
  window.__ieltsCoachDrain = () => queue.splice(0, queue.length);
  window.__ieltsCoachSnapshot = () => {
    const articles = [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')];
    const nodes = articles.length ? articles : [...document.querySelectorAll('[data-message-author-role]')];
    return nodes.map((node, index) => {
      const attributed = node.matches?.('[data-message-author-role]') ? node : node.querySelector('[data-message-author-role]');
      const role = attributed?.getAttribute('data-message-author-role');
      const text = visibleText(node);
      const sourceMessageId = node.getAttribute('data-message-id') || attributed?.getAttribute('data-message-id') || node.id || 'turn-' + index;
      return { sourceMessageId, role, text, status: 'complete' };
    }).filter((row) => ['assistant', 'user'].includes(row.role) && row.text);
  };
  window.__ieltsCoachStop = () => {
    observer.disconnect();
    delete window.__ieltsCoachDrain;
    delete window.__ieltsCoachSnapshot;
    delete window.__ieltsCoachStop;
  };
  return true;
})()`

export class ChatGPTAdapter {
  constructor(contents, { onEvent, onUnsupported }) {
    this.contents = contents
    this.onEvent = onEvent
    this.onUnsupported = onUnsupported
    this.timer = undefined
    this.supported = true
  }

  async start() {
    this.stop()
    this.supported = true
    try {
      await this.contents.executeJavaScript(observerScript, true)
    } catch {
      this.markUnsupported()
      return false
    }
    this.timer = setInterval(() => { void this.drain() }, 350)
    return true
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (!this.contents?.isDestroyed()) {
      void this.contents.executeJavaScript('window.__ieltsCoachStop?.()', true).catch(() => undefined)
    }
  }

  async snapshot() {
    if (!this.contents || this.contents.isDestroyed()) return []
    return this.contents.executeJavaScript('window.__ieltsCoachSnapshot?.() ?? []', true).catch(() => [])
  }

  async drain() {
    if (!this.supported || !this.contents || this.contents.isDestroyed()) return
    try {
      const events = await this.contents.executeJavaScript('window.__ieltsCoachDrain?.() ?? null', true)
      if (!events) return this.markUnsupported()
      for (const event of events) {
        this.onEvent({ ...event, capturedAt: new Date().toISOString() })
      }
    } catch {
      this.markUnsupported()
    }
  }

  markUnsupported() {
    if (!this.supported) return
    this.supported = false
    this.stop()
    this.onUnsupported?.()
  }
}
