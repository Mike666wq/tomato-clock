// 应用外壳。第 1 轮只有主界面（计时）；
// 统计页与设置页在第 4 轮接入导航。

import { TitleBar } from './components/TitleBar'
import { Timer } from './pages/Timer'

export default function App(): React.JSX.Element {
  return (
    <div className="app">
      <TitleBar />
      <Timer />
    </div>
  )
}
