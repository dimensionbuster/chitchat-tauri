/**
 * 전용 RTCDataChannel 처리량 벤치: Trystero 룸의 RTCPeerConnection 위에 채널을 직접 하나 더 연다.
 * 사용: node bench-raw.mjs <win2lab|lab2win> <청크KB> <버퍼한도KB> [총MB]
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
  eval: async expr => (await (await fetch(`http://localhost:${port}/eval`, { method: 'POST', body: expr })).json()).value,
})

const [dir, chunkKB = '64', bufKB = '4096', totalMB = '128'] = process.argv.slice(2)
const win = await winSession()
const a = lab(7702)
const room = `lab-raw-${crypto.randomBytes(3).toString('hex')}`
await win.navigate(`${DEV}/?r=${Date.now()}#/chat?roomId=${room}&name=Win`)
for (let i = 0; i < 60 && !(await win.eval('!!window.__room')); i++) await sleep(500)
await a.call('/open', { room, name: 'LabA' })
for (let i = 0; i < 180; i++) {
  if ((await win.eval('window.__room.mesh.peers.size')) >= 1) break
  await sleep(500)
}

// 받는 쪽: datachannel 이벤트를 듣는다 (Trystero의 자체 핸들러와 공존하도록 addEventListener)
const listen = `(()=>{ const room=window.__room.mesh.room; const pc=Object.values(room.getPeers())[0]; window.__raw={bytes:0,msgs:0,t0:0,last:0,label:null}; pc.addEventListener('datachannel',e=>{ if(e.channel.label!=='bulk') return; e.channel.binaryType='arraybuffer'; window.__raw.label='bulk'; e.channel.onmessage=m=>{ const r=window.__raw; if(!r.t0) r.t0=performance.now(); r.bytes+=m.data.byteLength; r.msgs++; r.last=performance.now() } }); return 1 })()`
const sendJs = `(async()=>{ const room=window.__room.mesh.room; const pc=Object.values(room.getPeers())[0]; const dc=pc.createDataChannel('bulk',{ordered:true}); dc.binaryType='arraybuffer'; const limit=${Number(bufKB) * 1024}; dc.bufferedAmountLowThreshold=limit/2; await new Promise((res,rej)=>{ if(dc.readyState==='open') res(); dc.onopen=()=>res(); setTimeout(()=>rej(new Error('open timeout')),15000) }); const size=${Number(chunkKB) * 1024}; const total=${Number(totalMB)}*1048576; const buf=new Uint8Array(size); let sent=0; const t=performance.now(); while(sent<total){ if(dc.bufferedAmount>limit){ await new Promise(r=>{ dc.onbufferedamountlow=()=>{dc.onbufferedamountlow=null; r()} }) } dc.send(buf); sent+=size } while(dc.bufferedAmount>0) await new Promise(r=>setTimeout(r,5)); return performance.now()-t })()`

// mesh.room은 private이라 디버그용으로 접근
const exposeRoom = `(()=>{ return typeof window.__room.mesh.room })()`
const recv = dir === 'win2lab' ? a : { eval: e => win.eval(e) }
const sender = dir === 'win2lab' ? { eval: e => win.eval(e) } : a
console.log('mesh.room 접근:', await sender.eval(exposeRoom))
await recv.eval(listen)
const sendMs = await sender.eval(sendJs)
await sleep(1500)
const b = JSON.parse(await recv.eval('JSON.stringify(window.__raw)'))
console.log(`${dir} 전용 채널 청크 ${chunkKB}KB 버퍼 ${bufKB}KB: 송신 ${(totalMB / (sendMs / 1000)).toFixed(1)} MB/s, 수신 ${(b.bytes / 1048576 / ((b.last - b.t0) / 1000)).toFixed(1)} MB/s (${(b.bytes / 1048576).toFixed(0)}MB, ${b.msgs}msgs)`)
process.exit()
