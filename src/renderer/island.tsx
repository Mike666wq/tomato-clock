// 灵动岛渲染层入口：独立于主窗口的第二个渲染入口。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Island from './island/Island'
import './styles/tokens.css'
import './styles/island.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <Island />
  </StrictMode>
)
