// 灵动岛渲染层入口：独立于主窗口的第二个渲染入口。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Island from './island/Island'
import './styles/tokens.css'
// 灵动岛有自己的皮肤（深色玻璃胶囊），跟主窗口的三套主题无关。
// v0.5 第 5 步才让它跟随主窗口主题。
import './styles/themes/island-glass.css'
import './styles/island.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <Island />
  </StrictMode>
)
