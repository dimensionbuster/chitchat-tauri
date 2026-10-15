/**
 * 네트워크 랩 시나리오 러너 (Windows에서 실행).
 *
 * Windows 쪽 피어 = 실제 Tauri 앱(WebView2, CDP 9222). 원격 피어 = WSL의 peer.cjs(별도 NAT 네트워크).
 * 사전 조건: `tauri dev`가 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 로 떠 있고,
 *            WSL에서 peer.cjs가 --control 7702(labA), 7703(labB)로 떠 있을 것.
 *
 * 사용: node run.mjs smoke
 *       node run.mjs xfer <win2lab|lab2win> <sizeMB> [netem 인자]
 */

import crypto from 'node:crypto'
import { cdpSession, lab, sleep, waitFor, joinRoom, reportPaths, makeTestFile, sampleProgress, fmtMBps } from './lib.mjs'

// --- 시나리오 ---
async function smoke() {
  const win = await cdpSession()
  const a = lab(7702)
  const room = `lab-smoke-${crypto.randomBytes(3).toString('hex')}`
  console.log(`[smoke] 방 ${room}`)
  const t0 = Date.now()
  await joinRoom(win, [a], room)
  console.log(`  피어 연결까지 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  await reportPaths(win)
  const labPeers = await a.eval('window.__room.mesh.peers.size')
  const winPeers = await win.eval('window.__room.mesh.peers.size')
  console.log(`  Windows 피어 ${winPeers}명, 랩 피어 ${labPeers}명`)
  win.close()
}

async function xfer(direction, sizeMB, netem) {
  const win = await cdpSession()
  const a = lab(7702)
  const room = `lab-xfer-${crypto.randomBytes(3).toString('hex')}`
  console.log(`[xfer] ${direction} ${sizeMB}MB netem=${netem ?? '없음'} 방 ${room}`)
  await a.netemClear().catch(() => undefined)
  await joinRoom(win, [a], room)
  await reportPaths(win)

  let sender, receiver, id, size
  if (direction === 'win2lab') {
    const file = makeTestFile(sizeMB).replace(/\\/g, '\\\\')
    const imp = await win.eval(`(async()=>{ const {blobs}=await import('/src/core/net/blobs.ts'); const imp=await blobs.importPath('${file}'); window.__room.attachFileMeta(imp.id,{name:'test.bin',size:imp.size,type:'application/octet-stream'},'user-win','Win'); return imp })()`)
    ;({ id, size } = imp)
    sender = win
    receiver = { eval: expr => a.eval(expr), evalLong: expr => a.evalLong(expr) }
  } else {
    const seeded = await a.seed(sizeMB)
    ;({ id, size } = seeded)
    await a.eval(`(()=>{ window.__room.attachFileMeta('${id}',{name:'test.bin',size:${size},type:'application/octet-stream'},'user-lab','Lab'); return 1 })()`)
    sender = a
    receiver = { eval: expr => win.eval(expr), evalLong: expr => win.eval(expr) }
  }
  console.log(`  파일 id ${id.slice(0, 12)}… ${(size / 1048576).toFixed(0)}MB`)

  await waitFor('수신 측에 파일 메타 동기화', async () => receiver.eval(`window.__room.files.has('${id}')`), 60000)
  if (netem) {
    await a.netem(netem)
    console.log(`  netem 적용: ${netem}`)
  }

  const stop = { done: false }
  const sampler = sampleProgress(expr => receiver.eval(expr), id, stop)
  const t0 = Date.now()
  let result
  try {
    const limitSec = Number(process.env.LIMIT_SEC || 240)
    const download = receiver.evalLong(`(async()=>{ try { await window.__room.transfers.download({id:'${id}',size:${size},name:'test.bin'}); return 'ok' } catch (e) { return 'ERR '+e.message } })()`)
    const timeout = sleep(limitSec * 1000).then(() => 'TIMEOUT')
    result = await Promise.race([download, timeout])
    if (result === 'TIMEOUT') await receiver.eval(`window.__room.transfers.cancel('${id}')`)
  } finally {
    stop.done = true
  }
  const ms = Date.now() - t0
  const samples = await sampler
  const status = direction === 'win2lab' ? await a.stat(id) : await win.eval(`(async()=>{ const {blobs}=await import('/src/core/net/blobs.ts'); return blobs.stat('${id}') })()`)
  const maxPeers = Math.max(0, ...samples.map(s => s.peers))
  const peakSpeed = Math.max(0, ...samples.map(s => s.speed))
  console.log(`  결과: ${result}, ${(ms / 1000).toFixed(1)}s, 평균 ${fmtMBps(size, ms)}, 최고 ${(peakSpeed / 1048576).toFixed(1)} MB/s, 최대 동시 소스 ${maxPeers}`)
  console.log(`  수신 블롭 상태: ${JSON.stringify(status)}  (complete면 SHA-256 검증 통과)`)
  await a.netemClear().catch(() => undefined)
  win.close()
  if (result !== 'ok' || status.state !== 'complete') process.exitCode = 1
}

const [scenario, ...rest] = process.argv.slice(2)
try {
  if (scenario === 'smoke') await smoke()
  else if (scenario === 'xfer') await xfer(rest[0], Number(rest[1]), rest.slice(2).join(' ') || undefined)
  else console.log('사용: node run.mjs smoke | xfer <win2lab|lab2win> <sizeMB> [netem 인자]')
} catch (error) {
  console.error('실패:', error.message)
  process.exitCode = 1
}
process.exit()
