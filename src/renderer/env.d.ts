/// <reference types="vite/client" />

import type { PreloadApi } from '../preload'
import type { IslandApi } from '../preload/island'

declare global {
  interface Window {
    pomodoro?: PreloadApi
    island?: IslandApi
  }
}

export {}
