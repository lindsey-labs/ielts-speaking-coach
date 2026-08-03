import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [dashboard, template, preload, main] = await Promise.all([
  readFile(new URL('../demo/dashboard.html', import.meta.url), 'utf8'),
  readFile(new URL('../skills/ielts-speaking-coach/assets/dashboard-template.html', import.meta.url), 'utf8'),
  readFile(new URL('./dashboard-preload.cjs', import.meta.url), 'utf8'),
  readFile(new URL('./main.mjs', import.meta.url), 'utf8')
])

for (const html of [dashboard, template]) {
  assert.match(html, />同步复盘报告<\/button>/)
  assert.match(html, />补生成复盘报告<\/button>/)
  assert.doesNotMatch(html, />结束并生成复盘<\/button>/)
  assert.doesNotMatch(html, /重新同步报告/)
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
  scripts.forEach((match) => new Function(match[1]))
}

assert.match(preload, /syncGeneratedReview/)
assert.match(preload, /generateMissingReview/)
assert.match(main, /ielts:sync-generated-review/)
assert.match(main, /ielts:generate-missing-review/)

process.stdout.write('Review control tests passed.\n')
