#!/usr/bin/env node
/**
 * 把 dsh-tool-image-ark 装进某个 dsh profile。
 *
 * package.json 里声明了 dsh.bundle → dsh 会把它当成一个 profile bundle：
 * 选中它，并把 cordis.patch.yml 作为一层 patch 叠上去。那一层在 profile 根层
 * insert 了 tool-image-ark 行，用 ctx.tools.register 注册全局工具——所以
 * 不需要改任何 agent preset。
 *
 * 用法：node install.mjs [profile] [--dry-run]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'dsh-tool-image-ark'
const ROW_ID = 'tool-image-ark'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const profile = argv.find((arg) => !arg.startsWith('--')) || 'web'
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const dshBin = process.env.DSH_BIN || 'dsh'

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function dsh(args) {
  return execFileSync(dshBin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

if (!existsSync(profileDir)) {
  fail(`profile "${profile}" 不存在。先建一个：dsh plugin --profile ${profile} add ${HERE}`)
}

// 1. 装依赖（dsh 会自动把 dsh.bundle 追加进 dsh.profile.bundles）
if (dryRun) {
  console.log(`[dry-run] dsh plugin --profile ${profile} add ${HERE}`)
} else {
  console.log(`→ 安装 ${PACKAGE_NAME} 到 profile "${profile}" …`)
  try {
    execFileSync(dshBin, ['plugin', '--profile', profile, 'add', HERE], { stdio: 'inherit' })
  } catch {
    fail('dsh plugin add 失败：检查 pnpm 是否可用，以及 package.json 的 peerDependencies 是否匹配当前 DSH 版本')
  }
}

// 2. 复核：bundle 被选中 + patch 层生效
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const bundles = manifest?.dsh?.profile?.bundles ?? []
if (!bundles.includes(PACKAGE_NAME)) {
  fail(
    `bundle 没被选中（${join(profileDir, 'package.json')} 的 dsh.profile.bundles 里没有 ${PACKAGE_NAME}）。` +
      'package.json 里的 dsh.bundle.patch 是否指向了存在的 cordis.patch.yml？',
  )
}

let dump = ''
try {
  dump = dsh(['--profile', profile, '--dump-config'])
} catch (error) {
  fail(`--dump-config 失败：${error.stderr || error.message}`)
}
const rowPresent = dump.includes(`- id: ${ROW_ID}`) && dump.includes(PACKAGE_NAME)
if (!rowPresent) {
  fail(`bundle 已选中，但 patch 层没产出 ${ROW_ID} 行，检查 cordis.patch.yml 是否被 files 字段包含`)
}

// 3. 已装且已生效时保持幂等
console.log(`✓ bundle 已选中：${PACKAGE_NAME}`)
console.log(`✓ patch 层已生效：${ROW_ID} → generate_image（全局工具）`)

if (!process.env.ARK_API_KEY) {
  console.log('')
  console.log('⚠ 还没检测到 ARK_API_KEY。生成图片会失败，二选一：')
  console.log('  CLI：export ARK_API_KEY=你的方舟key')
  console.log(`  桌面版：node ${join(HERE, 'set-key.mjs')} ${profile} 你的方舟key`)
}

console.log('')
console.log('下一步：')
console.log(`  1) 重启：dsh --profile ${profile}`)
console.log('  2) 对话里说「画一只在雪地里的柴犬」，模型会调用 generate_image')
console.log(`  3) 卸载：dsh plugin --profile ${profile} remove ${PACKAGE_NAME}`)
