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
        input: 'src/preload/index.ts'
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
        input: 'index.html'
      }
    }
  }
})
