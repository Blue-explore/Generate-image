#!/usr/bin/env node
/**
 * 把方舟 API Key 写进某个 dsh profile 的 patch 层，供 dsh-tool-image-ark 读取。
 *
 * 为什么需要它：桌面版 DeepSeek Harness 从 Finder 启动，拿不到你 shell 里的
 * ARK_API_KEY；插件的配置只能来自 profile 的 cordis.patch.yml（或插件行 config）。
 * 这个脚本就是替你改那一行，免得手写 YAML。
 *
 * 用法：
 *   node set-key.mjs                    # 默认 profile=desktop，key 取 $ARK_API_KEY
 *   node set-key.mjs web                # 指定 profile
 *   node set-key.mjs desktop 你的key     # 直接给 key
 *   node set-key.mjs desktop --clear    # 删掉写入的 key
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROW_ID = 'tool-image-ark'
const PACKAGE_NAME = 'dsh-tool-image-ark'

const argv = process.argv.slice(2)
const clear = argv.includes('--clear')
const positional = argv.filter((arg) => !arg.startsWith('--'))
const profile = positional[0] || 'desktop'
const key = (positional[1] || process.env.ARK_API_KEY || '').trim()

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const patchFile = join(profileDir, 'cordis.patch.yml')

const HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!existsSync(profileDir)) fail(`profile "${profile}" 不存在（${profileDir}）`)
if (!clear && !key) {
  fail('没有拿到 key。用法：node set-key.mjs ' + profile + ' 你的方舟key，或先 export ARK_API_KEY')
}
if (key && !/^[\x21-\x7e]+$/.test(key)) fail('key 里含空格或非 ASCII 字符，检查是否复制多了')
if (key && /\s/.test(key)) fail('key 里含空白字符，可能复制了换行')

// 1. 读现有 patch，先摘掉本插件已有的行（整块，含缩进子行）
const source = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : HEADER
const lines = source.split('\n')
const kept = []
let skipping = false
for (const line of lines) {
  if (/^-\s+id:\s*['"]?/.test(line)) {
    const id = line.replace(/^-\s+id:\s*['"]?/, '').replace(/['"]?\s*$/, '')
    skipping = id === ROW_ID
  }
  if (!skipping) kept.push(line)
}

// 2. 需要时追加新的行
const trimmed = kept.join('\n').replace(/\s+$/, '')
const block = clear
  ? ''
  : [
      `- id: ${ROW_ID}`,
      `  name: ${PACKAGE_NAME}`,
      '  config:',
      `    apiKey: ${key}`,
    ].join('\n')

const next = [trimmed, block].filter(Boolean).join('\n\n') + '\n'

if (existsSync(patchFile)) {
  const backup = `${patchFile}.bak-${Date.now()}`
  copyFileSync(patchFile, backup)
  console.log(`→ 已备份：${backup}`)
}
mkdirSync(profileDir, { recursive: true })
writeFileSync(patchFile, next)
try {
  chmodSync(patchFile, 0o600)
} catch {
  /* 非 POSIX 文件系统忽略 */
}

if (clear) {
  console.log(`✓ 已从 profile "${profile}" 移除 ${ROW_ID} 的 apiKey 覆盖`)
  console.log(`  下次启动将回落到环境变量 ARK_API_KEY`)
} else {
  const masked = `${key.slice(0, 4)}…${key.slice(-4)}`
  console.log(`✓ 已写入 profile "${profile}"：${patchFile}`)
  console.log(`  apiKey = ${masked}（明文保存在该文件，权限 600）`)
  console.log('')
  console.log('下一步：完全退出 DeepSeek Harness 再打开（不是关窗口，是退出进程），')
  console.log('然后说「画一只在雪地里的柴犬」。')
}
