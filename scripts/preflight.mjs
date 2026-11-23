// 验证脚本的前置自检。
//
// 肥鱼立的规矩（2026-11-23 晚）：
//   「验证脚本没有前置自检，全靠人记文档 —— 记忆会失手，脚本不会。
//     给它加一道开跑前的自检，不过就 abort 并打印原因，不许带病往下跑。」
//
// 三条：
//   1. E2E_DATA 与被测实例的 userData 必须是同一处，不一致直接停
//   2. 起子进程前清掉 ELECTRON_RUN_AS_NODE
//   3. 进程筛选一律按可执行文件路径，禁止按命令行片段筛
//
// 教训从哪来的（都是这轮真踩的）：
//   ① 端到端一次 FAIL 15 项 —— 开发版实例的 userData 是 .tmp\shot，
//      脚本读的却是 .tmp\e2e\data.json，两边各读各的文件。
//   ② 打包版 exe 退出码 9 —— ELECTRON_RUN_AS_NODE 残留，
//      exe 被当成 node 跑（node 的 bad option 退出码正好是 9）。
//   ③ 按命令行片段筛进程，把 DS Bot 自己的 runner 也匹配进去，自杀了一条命令。

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** 实例清单：start-instance.mjs 写的，preflight 读它 */
export const INSTANCE_FILE = path.join('.tmp', 'instance.json')

/** 自检不通过 → 打印原因 + 退出码 1（不许带病往下跑） */
export function abort(reason, hint) {
  console.error(`\n[自检不通过] ${reason}`)
  if (hint) console.error(`  ${hint}`)
  console.error('  —— 带病不跑。修好上面这条再来。\n')
  process.exit(1)
}

/** 读实例清单（没有就 null） */
export function loadInstance(root = process.cwd()) {
  const file = path.join(root, INSTANCE_FILE)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    abort(`实例清单读不出来：${file}`, '删掉它，用 scripts/start-instance.mjs 重新起一个实例')
  }
}

/** 路径归一化（Windows 大小写不敏感） */
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

/**
 * 开跑前自检。
 *
 * @param {object} opts
 * @param {string} opts.dataFile    脚本要读的数据文件（E2E_DATA）
 * @param {string} opts.snapshotFile 脚本要读的运行快照（E2E_SNAPSHOT）
 * @param {string} opts.label       出错时说的是哪个脚本
 * @param {boolean} opts.needResize 是否要求配置进程筛选方式（要拖窗口的脚本才需要）
 */
export function preflight(opts = {}) {
  const label = opts.label ?? '验证脚本'
  const dataFile = opts.dataFile ?? process.env.E2E_DATA
  const snapshotFile = opts.snapshotFile ?? process.env.E2E_SNAPSHOT
  const instance = loadInstance()

  // ---- 2. ELECTRON_RUN_AS_NODE：残留会把 Electron 打包产物当 node 跑 ----
  if (process.env.ELECTRON_RUN_AS_NODE) {
    delete process.env.ELECTRON_RUN_AS_NODE
    console.log('[自检] 已清掉 ELECTRON_RUN_AS_NODE（残留会让 exe 被当 node 跑，退出码 9）')
  }

  // ---- 1. 数据目录必须与被测实例的 userData 是同一处 ----
  const userData = process.env.E2E_USER_DATA ?? instance?.userData
  if (!userData) {
    abort(
      `${label}：说不清被测实例的 userData 在哪`,
      '用 scripts/start-instance.mjs 起实例（它会写 .tmp/instance.json），或直接设 E2E_USER_DATA'
    )
  }
  if (!dataFile) {
    abort(
      `${label}：没给 E2E_DATA`,
      `被测实例的 userData 是 ${userData}，数据文件应该是 ${path.join(userData, 'data.json')}`
    )
  }
  const expectedData = path.join(path.resolve(userData), 'data.json')
  if (!samePath(dataFile, expectedData)) {
    abort(
      `${label}：E2E_DATA 与被测实例的 userData 不是同一处`,
      `E2E_DATA=${path.resolve(dataFile)}\n  实例 userData=${path.resolve(userData)}\n  ` +
        `两者应该是同一个文件：${expectedData}\n  ` +
        '（两边各读各的文件 → 断言会成片失败，那是测试环境坏了，不是程序坏了）'
    )
  }
  if (snapshotFile) {
    const expectedSnap = path.join(path.resolve(userData), 'running.json')
    if (!samePath(snapshotFile, expectedSnap)) {
      abort(
        `${label}：E2E_SNAPSHOT 与被测实例的 userData 不是同一处`,
        `E2E_SNAPSHOT=${path.resolve(snapshotFile)}\n  应该是 ${expectedSnap}`
      )
    }
  }

  // ---- 3. 进程筛选：只准按可执行文件路径 ----
  if (process.env.E2E_RESIZE_CMD) {
    abort(
      `${label}：E2E_RESIZE_CMD 是按命令行片段筛进程，已废弃`,
      '按命令行片段筛会把「自己这条命令」也匹配进去（自杀过一次）。改用 E2E_RESIZE_EXE=<可执行文件路径通配>'
    )
  }
  if (opts.needResize && !process.env.E2E_RESIZE_EXE) {
    abort(
      `${label}：没给 E2E_RESIZE_EXE，拖窗口不知道该拖哪个进程`,
      '按可执行文件路径通配，例如 E2E_RESIZE_EXE="*\\release\\win-unpacked\\*.exe"'
    )
  }

  // 端口对不上也停：连错实例 = 测了另一个程序
  if (instance?.port && process.env.CDP_PORT && String(instance.port) !== String(process.env.CDP_PORT)) {
    abort(
      `${label}：CDP_PORT 与实例清单里的端口不一致`,
      `CDP_PORT=${process.env.CDP_PORT}，实例是 ${instance.port}`
    )
  }

  return {
    userData: path.resolve(userData),
    dataFile: path.resolve(dataFile),
    instance
  }
}
