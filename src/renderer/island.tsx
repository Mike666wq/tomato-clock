// 灵动岛渲染层入口：独立于主窗口的第二个渲染入口。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Island from './island/Island'
import './styles/tokens.css'
// 灵动岛跟随主窗口主题，所以三套主题文件也得进这个包（岛只用其中的 --island-* 变量）
import './styles/themes/paper.css'
import './styles/themes/neon.css'
import './styles/themes/ios.css'
// 灵动岛有自己的皮肤（深色玻璃胶囊）：主题没到之前（或者没有主题时）的底色
import './styles/themes/island-glass.css'
import './styles/island.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <Island />
  </StrictMode>
)
