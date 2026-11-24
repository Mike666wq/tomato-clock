// 等 CI 出 v0.3.10 的包，出好了就下载免安装单文件版。
//
// 只用 API 判成败（网页抓取会把 in_progress/failure 的关键词匹配错，之前误判过）。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const outDir = path.join(root, '.tmp', 'pkg0310')
mkdirSync(outDir, { recursive: true })
const exe = path.join(outDir, 'tomato-clock-0.3.10-portable-single.exe')

function token() {
  const cred = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf-8'
  })
  const m = /^password=(.*)$/m.exec(cred)
  return m ? m[1].trim() : ''
}

async function api(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!res.ok) throw new Error(`API ${res.status} ${pathname}`)
  return res.json()
}

// ---- 等 CI ----
let run = null
for (let i = 0; i < 60; i++) {
  const runs = await api('/repos/Mike666wq/tomato-clock/actions/runs?per_page=10')
  run = runs.workflow_runs.find((r) => r.head_branch === 'v0.3.10')
  if (run) {
    console.log(`[CI] ${run.status} ${run.conclusion ?? ''}`)
    if (run.status === 'completed') break
  }
  await sleep(60000)
}
if (!run || run.status !== 'completed') {
  console.error('[CI] 没等到结果')
  process.exit(1)
}
if (run.conclusion !== 'success') {
  console.error(`[CI] 失败了：${run.conclusion}`)
  process.exit(1)
}
console.log('[CI] 成功')

// ---- 等 release 附件 ----
let assets = []
for (let i = 0; i < 30; i++) {
  const rel = await api('/repos/Mike666wq/tomato-clock/releases/tags/v0.3.10')
  assets = rel.assets ?? []
  if (assets.length >= 3) break
  await sleep(20000)
}
console.log('[附件]', assets.map((a) => `${a.name} ${(a.size / 1048576).toFixed(1)}MB`).join(' | '))
const single = assets.find((a) => a.name.includes('portable-single'))
if (!single) {
  console.error('[附件] 没有免安装单文件版')
  process.exit(1)
}

// ---- 下载 ----
if (existsSync(exe) && statSync(exe).size > 50 * 1048576) {
  console.log(`[下载] 已有，跳过：${exe}`)
} else {
  const res = await fetch(single.browser_download_url, { redirect: 'follow' })
  if (!res.ok) {
    console.error(`[下载] HTTP ${res.status}`)
    process.exit(1)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const { writeFileSync } = await import('node:fs')
  writeFileSync(exe, buf)
  console.log(`[下载] ${exe} ${(buf.length / 1048576).toFixed(1)}MB`)
}
console.log('[完成] 可以验包了')
process.exit(0)
