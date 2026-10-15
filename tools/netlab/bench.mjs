/**
 * 채널 처리량 마이크로벤치 (디스크/전송 서비스 없이 Mesh 채널만).
 * 병목이 Trystero 액션 계층인지 앱 코드인지 가리는 용도.
 * 사용: node bench.mjs <win2lab|lab2win> <msgKB> <동시전송수> [총MB]
 */
import crypto from 'node:crypto'

const CDP = 'http://localhost:9222'
const DEV = 'http://localhost:5173'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function winSession() {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  const page = list.find(p => p.type === 'page' && p.url.startsWith(DEV))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id))
  }
  const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Runtime.enable', {})
  return {
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
      return r.result.result.value
    },
    async navigate(url) { await send('Page.navigate', { url }); await sleep(3000) },
  }
}

const lab = port => ({
  call: async (p, body) => (await fetch(`http://localhost:${port}${p}`, { method: 'POST', body: JSON.stringify(body ?? {}) })).json(),
  eval: async function (expr) { return (await (await fetch(`http://localhost:${port}/eval`, { method: 'POST', body: expr })).json()).value },
})

const [dir, msgKB = '1024', conc = '4', totalMB = '64'] = process.argv.slice(2)
const win = await winSession()
const a = lab(7702)
const room = `lab-bench-${crypto.randomBytes(3).toString('hex')}`
await win.navigate(`${DEV}/?r=${Date.now()}#/chat?roomId=${room}&name=Win`)
for (let i = 0; i < 60 && !(await win.eval('!!window.__room')); i++) await sleep(500)
await a.call('/open', { room, name: 'LabA' })
for (let i = 0; i < 180; i++) {
  if ((await win.eval('window.__room.mesh.peers.size')) >= 1) break
  await sleep(500)
}

const setupRecv = `(()=>{ const ch=window.__room.mesh.channel('bench'); window.__bench={bytes:0,msgs:0,t0:0}; ch.onMessage(m=>{ if(!window.__bench.t0) window.__bench.t0=performance.now(); window.__bench.bytes+=m.data.byteLength; window.__bench.msgs++; window.__bench.last=performance.now() }); return 1 })()`
const runSend = `(async()=>{ const ch=window.__room.mesh.channel('bench'); const peer=[...window.__room.mesh.peers][0]; const size=${Number(msgKB) * 1024}; const total=${Number(totalMB)}*1048576; const n=Math.ceil(total/size); const buf=new Uint8Array(size); let sent=0, inflight=0; const t=performance.now(); await new Promise((resolve,reject)=>{ const pump=()=>{ while(inflight<${Number(conc)}&&sent<n){ sent++; inflight++; ch.send(buf,{target:peer}).then(()=>{inflight--; if(sent>=n&&inflight===0) resolve(); else pump()}).catch(reject) } }; pump() }); return performance.now()-t })()`

const recv = dir === 'win2lab' ? a : { eval: e => win.eval(e) }
const sender = dir === 'win2lab' ? { eval: e => win.eval(e) } : a
await recv.eval(setupRecv)
await sender.eval(setupRecv)
const sendMs = await sender.eval(runSend)
await sleep(1500)
const r = await recv.eval('JSON.stringify(window.__bench)')
const b = JSON.parse(r)
const recvMs = b.last - b.t0
console.log(`${dir} 메시지 ${msgKB}KB x 동시 ${conc}: 송신 ${(totalMB / (sendMs / 1000)).toFixed(1)} MB/s (send 완료 기준), 수신 ${(b.bytes / 1048576 / (recvMs / 1000)).toFixed(1)} MB/s, 수신 ${(b.bytes / 1048576).toFixed(0)}MB/${b.msgs}msgs`)
process.exit()
