import assert from 'node:assert/strict'
import { answerUpgradeGuidance } from './answer-upgrade-policy.mjs'

const part1 = answerUpgradeGuidance('Part 1')
assert.match(part1, /2至4句/)
assert.match(part1, /不得把补充内容伪装成考生亲身事实/)
assert.match(part1, /不得硬塞俚语/)

const part2 = answerUpgradeGuidance('Part 2')
assert.match(part2, /最多两分钟/)
assert.match(part2, /90至120秒/)
assert.match(part2, /若真实个人信息不足/)

const part3 = answerUpgradeGuidance('Part 3')
assert.match(part3, /4至7句/)
assert.match(part3, /观点、原因、解释或例子/)

const fallback = answerUpgradeGuidance('full mock')
assert.match(fallback, /先根据问题所属Part/)

process.stdout.write('Answer upgrade policy tests passed.\n')
