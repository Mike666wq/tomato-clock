// 一次性探针：看岛的 preload 里到底有没有 setVolume，React 的 pointer 处理器有没有跑。
import path from 'node:path'
const port = process.env.CDP_PORT ?? '9222'
const res = await fetch(`http://127.0.0.1:${port}/json`)
const list = await res.json()
const islandT = list.find((t) => t.type === 'page' && t.url.includes('island.html'))
const ws = new WebSocket(islandT.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id
    const onMessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === mid) {
        ws.removeEventListener('message', onMessage)
        resolve(m?.result?.value ?? null)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => reject(new Error('timeout ' + method)), 15000)
  })
}
const evaluate = (expr) =>
  send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })

console.log('preload media API:', JSON.stringify(await evaluate(`Object.keys(window.island?.media ?? {})`)))
console.log('setVolume type:', await evaluate(`typeof window.island?.media?.setVolume`))
console.log('getVolume type:', await evaluate(`typeof window.island?.media?.getVolume`))
console.log('has .island__vol:', await evaluate(`!!document.querySelector('.island__vol')`))
console.log(
  'react root container:',
  await evaluate(`(() => { const r = document.getElementById('root'); return r ? r.outerHTML.slice(0, 120) : 'none' })()`)
)
process.exit(0)
