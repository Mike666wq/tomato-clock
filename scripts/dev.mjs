// 开发启动脚本。
//
// 这台机器的环境里预置了 ELECTRON_RUN_AS_NODE=1，Electron 会被强制当成纯 Node 跑，
// 表现为 `TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
// 这里统一清掉这个变量，不用每次手动记得。

import { spawn } from 'node:child_process'

delete process.env.ELECTRON_RUN_AS_NODE

const child = spawn('electron-vite', ['dev'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32'
})

child.on('exit', (code) => process.exit(code ?? 0))
