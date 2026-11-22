import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/main/index.ts'
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 两个入口：主窗口用 index.js，灵动岛用 island.js
        input: {
          index: 'src/preload/index.ts',
          island: 'src/preload/island.ts'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    // resources/ 下的提示音等静态资源直接暴露给渲染层
    // 开发期：http://localhost:5173/ding.wav；打包后：out/renderer/ding.wav
    publicDir: '../../resources',
    plugins: [react()],
    build: {
      rollupOptions: {
        // 两个渲染入口：主界面 index.html，灵动岛 island.html
        input: {
          index: 'index.html',
          island: 'island.html'
        }
      }
    }
  }
})
