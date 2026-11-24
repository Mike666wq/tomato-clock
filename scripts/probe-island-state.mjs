// 诊断：岛的渲染层现在是什么状态？
// 用法：node scripts/probe-island-state.mjs

const port = process.env.CDP_PORT ?? '9222'
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('island.html'))
if (!t) {
  console.log('NO_ISLAND_TARGET')
  process.exit(1)
}
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
function send(method, params) {
  return new Promise((resolve) => {
    const mid = ++id
    const h = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id === mid) {
        ws.removeEventListener('message', h)
        resolve(msg.result?.result?.value)
      }
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
const v = await send('Runtime.evaluate', {
  expression: `(async () => {
    const el = document.documentElement;
    // ⚠ 这些是 Promise —— 必须 await，否则 JSON.stringify(Promise) 是 "{}"
    const settings = await window.island?.settings?.get?.();
    const state = await window.island?.media?.getState?.();
    return {
      mode: el.dataset.mode,
      expanded: !!document.querySelector('.island--expanded'),
      musicRow: !!document.querySelector('.island__music'),
      btnCount: document.querySelectorAll('.island__music-btn').length,
      state: state,
      showMusicControl: settings?.showMusicControl,
      devFakeType: typeof window.island?.media?.devFake,
      devRestartType: typeof window.island?.media?.devRestart
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
})
console.log(JSON.stringify(v, null, 2))
process.exit(0)
