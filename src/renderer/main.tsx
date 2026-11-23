import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/app.css'
// 主题层：颜色/圆角/数字字体/效果都在这三个文件里。
// 放在 app.css 之后——主题里的结构覆盖块要压得住 app.css 的默认形态。
import './styles/themes/paper.css'
import './styles/themes/neon.css'
import './styles/themes/ios.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
