/** 네트워크 랩 공용 헬퍼 (Windows 앱 CDP 제어 + 랩 피어 HTTP 제어). */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..')
export const CDP = 'http://localhost:9222'
export const DEV = 'http://localhost:5173'

// --- Windows 앱 (CDP) ---
export async function winPage() {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  const page = list.find(p => p.type === 'page' && p.url.startsWith(DEV))
  if (!page) throw new Error('앱 창을 찾을 수 없습니다 (tauri dev 실행 여부 확인)')
  return page
}

export async function cdpSession() {
  const page = await winPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise(resolve => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable')
  await send('Page.enable')
  return {
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
      return r.result?.result?.value
    },
    async navigate(url) {
      await send('Page.navigate', { url })
      await sleep(3000)
    },
    close: () => ws.close(),
  }
}

// --- 랩 피어 (HTTP) ---
export function lab(port) {
  const call = async (p, body, method = 'POST') => {
    const res = await fetch(`http://localhost:${port}${p}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
    const json = await res.json()
    if (!res.ok) throw new Error(`lab ${p}: ${json.error ?? res.status}`)
    return json
  }
  return {
    open: (room, name) => call('/open', { room, name }),
    close: () => call('/close', {}),
    eval: async expr => (await call('/eval', expr)).value,
    /** 오래 걸리는 평가: 백그라운드로 시작하고 폴링한다 (HTTP 타임아웃 회피) */
    evalLong: async expr => {
      const { id } = await call('/task', expr)
      for (;;) {
        await sleep(2000)
        const task = await call(`/task/${id}`, undefined, 'GET')
        if (task.done) {
          if (task.error) throw new Error(task.error)
          return task.value
        }
      }
    },
    seed: sizeMB => call('/seed', { sizeMB }),
    netem: args => call('/netem', { args }),
    netemClear: () => call('/netem', { clear: true }),
    corrupt: count => call('/corrupt', { count }),
    stat: id => call(`/stat/${id}`, undefined, 'GET'),
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export async function waitFor(label, fn, timeoutMs = 60000, everyMs = 500) {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`시간 초과: ${label}`)
    await sleep(everyMs)
  }
}
export const fmtMBps = (bytes, ms) => `${(bytes / 1048576 / (ms / 1000)).toFixed(1)} MB/s`

// --- 공통 단계 ---
export async function joinRoom(win, labs, room) {
  await win.navigate(`${DEV}/?r=${Date.now()}#/chat?roomId=${encodeURIComponent(room)}&name=Win`)
  await waitFor('Windows 앱 룸 준비', () => win.eval('!!window.__room'), 30000)
  await Promise.all(labs.map((l, i) => l.open(room, `Lab${i}`)))
  const want = labs.length
  await waitFor(`피어 ${want}명 연결`, async () => (await win.eval('window.__room.mesh.peers.size')) >= want, 90000)
  await Promise.all(labs.map(l => waitFor('랩 피어 연결', async () => (await l.eval('window.__room.mesh.peers.size')) >= 1, 90000)))
}

export async function reportPaths(win) {
  const paths = await win.eval(`(async()=>{ const m=window.__room.mesh; const out=[]; for (const id of m.peers) out.push(await m.getPeerPath(id)); return out })()`)
  console.log('  연결 경로:', JSON.stringify(paths))
}


export function makeTestFile(sizeMB) {
  const dir = path.join(REPO, 'test-data')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rand${sizeMB}.bin`)
  if (!fs.existsSync(file) || fs.statSync(file).size !== sizeMB * 1048576) {
    const fd = fs.openSync(file, 'w')
    for (let i = 0; i < sizeMB; i++) fs.writeSync(fd, crypto.randomBytes(1048576))
    fs.closeSync(fd)
  }
  return file
}

export async function sampleProgress(evalFn, id, stopRef) {
  const samples = []
  while (!stopRef.done) {
    const info = await evalFn(`(window.__room.transfers.transfers.get().find(t=>t.id==='${id}'&&t.direction==='download')||null)`).catch(() => null)
    if (info) {
      samples.push({ t: Date.now(), bytes: info.doneBytes, peers: info.peers, speed: info.speed, state: info.state })
      if (samples.length % 10 === 1) console.log(`    ${((info.doneBytes / info.size) * 100).toFixed(0)}%  ${(info.speed / 1048576).toFixed(2)} MB/s  소스 ${info.peers}  ${info.state}`)
    }
    await sleep(1000)
  }
  return samples
}

