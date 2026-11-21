/// <reference types="vite/client" />

import type { PreloadApi } from '../preload'

declare global {
  interface Window {
    pomodoro?: PreloadApi
  }
}

export {}
