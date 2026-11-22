// 打包前把媒体控制小工具（C#）发布成单文件 exe。
//
// 为什么要这一步：
//   灵动岛的音乐控制要调 WinRT 的 SMTC，Electron 主进程是 Node，没有投影。
//   方案是拉一个常驻子进程 tools/smtc/smtc.exe，打包时它被复制到
//   <resourcesPath>/resources/smtc/smtc.exe，主进程按这个路径找。
//
// 发布目标：tools/smtc/publish/（不进 git，构建时现生成）
//
// 没装 .NET SDK 也不阻断打包：发布失败就留一个空目录，
// 主进程找不到 exe 会静默降级（音乐那一行不出现），其它功能照常。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projDir = path.join(root, 'tools', 'smtc')
const outDir = path.join(projDir, 'publish')
const exePath = path.join(outDir, 'smtc.exe')

mkdirSync(outDir, { recursive: true })

if (existsSync(exePath)) {
  console.log('[prepare-smtc] 已有发布产物，跳过：' + exePath)
  process.exit(0)
}

console.log('[prepare-smtc] 发布 smtc.exe …')
try {
  execFileSync(
    'dotnet',
    [
      'publish',
      'SmtcTool.csproj',
      '-c',
      'Release',
      '-r',
      'win-x64',
      '--self-contained',
      'false',
      '-p:PublishSingleFile=true',
      '-o',
      outDir
    ],
    { cwd: projDir, stdio: 'inherit' }
  )
  console.log('[prepare-smtc] 完成：' + exePath)
} catch (err) {
  console.warn('[prepare-smtc] 发布失败（不影响打包，音乐控制会静默关闭）：' + err.message)
  // 留一个空目录，electron-builder 的 extraResources 才不会因为源目录不存在而报错
  try {
    for (const f of ['smtc.exe', 'smtc.pdb', 'smtc.deps.json', 'smtc.runtimeconfig.json']) {
      rmSync(path.join(outDir, f), { force: true })
    }
  } catch {
    /* 忽略 */
  }
}
