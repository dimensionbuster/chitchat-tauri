/**
 * 카오스 시나리오: 전송 중 끊김/재시작/손상/다중 소스 상황에서 파일이 끝까지, 올바르게 도착하는지 확인한다.
 *
 * 사용: node chaos.mjs <peer-leave|app-restart|corrupt|swarm|segment-loss>
 * 사전 조건: README의 랩 구성(Windows 앱 + WSL 피어; swarm은 피어 2개 `deploy.sh 2`).
 */

import crypto from 'node:crypto'
import { cdpSession, lab, sleep, waitFor, joinRoom, DEV } from './lib.mjs'

const room = () => `lab-chaos-${crypto.randomBytes(3).toString('hex')}`

async function winBlobStat(win, id) {
  return win.eval(`(async()=>{ const {blobs}=await import('/src/core/net/blobs.ts'); return blobs.stat('${id}') })()`)
}

/** Windows가 받는 쪽: 파일 메타를 기다린 뒤 다운로드를 시작하고, 진행 정보를 돌려주는 핸들 */
function startWinDownload(win, id, size) {
  const promise = win.eval(`(async()=>{ try { await window.__room.transfers.download({id:'${id}',size:${size},name:'chaos.bin'}); return 'ok' } catch (e) { return 'ERR '+e.message } })()`)
  const info = async () =>
    win.eval(`(window.__room.transfers.transfers.get().find(t=>t.id==='${id}'&&t.direction==='download')||null)`)
  return { promise, info }
}

async function seedAndAnnounce(l, win, sizeMB) {
  const { id, size } = await l.seed(sizeMB)
  await l.eval(`(()=>{ window.__room.attachFileMeta('${id}',{name:'chaos.bin',size:${size},type:'application/octet-stream'},'user-lab','Lab'); return 1 })()`)
  await waitFor('파일 메타 동기화', () => win.eval(`window.__room.files.has('${id}')`), 60000)
  return { id, size }
}

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' - ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

// 1) 전송 중 보내는 피어가 사라졌다가(페이지 닫힘) 돌아온다
async function peerLeave() {
  console.log('[peer-leave] 전송 중 송신 피어가 이탈했다가 복귀')
  const win = await cdpSession()
  const a = lab(7702)
  const r = room()
  await a.netemClear().catch(() => undefined)
  await joinRoom(win, [a], r)
  await a.netem('rate 24mbit')
  const { id, size } = await seedAndAnnounce(a, win, 120)
  const dl = startWinDownload(win, id, size)

  await waitFor('30% 도달', async () => ((await dl.info())?.doneBytes ?? 0) > size * 0.3, 120000, 300)
  console.log('  30% 도달 → 송신 피어 이탈')
  await a.close()
  await waitFor('waiting 상태 전환', async () => (await dl.info())?.state === 'waiting', 60000, 500)
  const atLeave = await dl.info()
  check('이탈 후 오류 없이 대기 상태', atLeave.state === 'waiting', `state=${atLeave.state}`)
  await sleep(8000)
  console.log('  8초 후 송신 피어 복귀')
  await a.open(r, 'LabA')
  const result = await Promise.race([dl.promise, sleep(180000).then(() => 'TIMEOUT')])
  check('복귀 후 이어서 완료', result === 'ok', String(result))
  const st = await winBlobStat(win, id)
  check('블롭 완성(해시 검증 통과)', st.state === 'complete', JSON.stringify(st))
  await a.netemClear().catch(() => undefined)
}

// 2) 수신 앱이 전송 중 재시작(페이지 리로드)되어도 구간 비트맵으로 이어받는다
async function appRestart() {
  console.log('[app-restart] 전송 중 수신 앱 재시작 후 이어받기')
  const win = await cdpSession()
  const a = lab(7702)
  const r = room()
  await a.netemClear().catch(() => undefined)
  await joinRoom(win, [a], r)
  await a.netem('rate 24mbit')
  const { id, size } = await seedAndAnnounce(a, win, 150)
  const dl = startWinDownload(win, id, size)
  await waitFor('30% 도달', async () => ((await dl.info())?.doneBytes ?? 0) > size * 0.3, 120000, 300)
  await sleep(1500) // 비트맵 저장(16구간마다) 여유
  const before = (await dl.info()).doneBytes
  console.log(`  ${(before / 1048576).toFixed(0)}MB 수신 시점에 앱 페이지 리로드`)

  await win.navigate(`${DEV}/?r=${Date.now()}#/chat?roomId=${encodeURIComponent(r)}&name=Win`)
  await waitFor('앱 재시작 후 룸 준비', () => win.eval('!!window.__room'), 30000)
  await waitFor('피어 재연결', async () => (await win.eval('window.__room.mesh.peers.size')) >= 1, 90000)
  await waitFor('파일 메타 재동기화', () => win.eval(`window.__room.files.has('${id}')`), 60000)

  const dl2 = startWinDownload(win, id, size)
  const first = await waitFor('재개 후 첫 진행 정보', async () => await dl2.info(), 60000, 200)
  const resumedFrom = first.doneBytes
  check('이어받기: 처음부터가 아니라 저장된 지점에서 재개', resumedFrom > size * 0.15, `재개 지점 ${(resumedFrom / 1048576).toFixed(0)}MB / 리로드 직전 ${(before / 1048576).toFixed(0)}MB`)
  const result = await Promise.race([dl2.promise, sleep(180000).then(() => 'TIMEOUT')])
  check('재시작 후 완료', result === 'ok', String(result))
  const st = await winBlobStat(win, id)
  check('블롭 완성(해시 검증 통과)', st.state === 'complete', JSON.stringify(st))
  await a.netemClear().catch(() => undefined)
}

// 3) 송신 측 디스크가 한 번 잘못 읽어 손상된 데이터를 보낸다 → 최종 해시 검증이 잡고 재시도로 복구
async function corrupt() {
  console.log('[corrupt] 송신 측 손상 데이터 → 해시 검증 → 재시도')
  const win = await cdpSession()
  const a = lab(7702)
  const r = room()
  await joinRoom(win, [a], r)
  const { id, size } = await seedAndAnnounce(a, win, 40)
  await a.corrupt(1)
  const t0 = Date.now()
  const result = await Promise.race([startWinDownload(win, id, size).promise, sleep(240000).then(() => 'TIMEOUT')])
  check('손상을 감지하고 재시도 끝에 정상 완료', result === 'ok', `${result}, ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  const st = await winBlobStat(win, id)
  check('블롭 완성(해시 검증 통과)', st.state === 'complete', JSON.stringify(st))
}

// 4) 같은 파일을 가진 피어 2명에게서 동시에 받는다
async function swarm() {
  console.log('[swarm] 보유 피어 2명에게서 동시 수신 (deploy.sh 2 필요)')
  const win = await cdpSession()
  const a = lab(7702)
  const b = lab(7704)
  const r = room()
  await joinRoom(win, [a, b], r)
  const { id, size } = await seedAndAnnounce(a, win, 150)
  // B가 먼저 A에게서 받아 같은 파일을 보유하게 한다
  await waitFor('B 피어 메타 동기화', () => b.eval(`window.__room.files.has('${id}')`), 60000)
  const prep = await b.evalLong(`(async()=>{ try { await window.__room.transfers.download({id:'${id}',size:${size},name:'chaos.bin'}); return 'ok' } catch (e) { return 'ERR '+e.message } })()`)
  check('B가 A에게서 파일 확보', prep === 'ok', String(prep))

  const dl = startWinDownload(win, id, size)
  let maxSources = 0
  const poll = (async () => {
    for (;;) {
      const i = await dl.info().catch(() => null)
      if (i) maxSources = Math.max(maxSources, i.peers)
      if (i?.state === 'done') return
      await sleep(250)
    }
  })()
  const result = await Promise.race([dl.promise, sleep(240000).then(() => 'TIMEOUT')])
  await Promise.race([poll, sleep(1000)])
  check('완료', result === 'ok', String(result))
  check('두 피어 모두 소스로 사용', maxSources >= 2, `최대 동시 소스 ${maxSources}`)
  const st = await winBlobStat(win, id)
  check('블롭 완성(해시 검증 통과)', st.state === 'complete', JSON.stringify(st))
}

const scenarios = { 'peer-leave': peerLeave, 'app-restart': appRestart, corrupt, swarm }
const name = process.argv[2]
if (!scenarios[name]) {
  console.log('사용: node chaos.mjs <' + Object.keys(scenarios).join('|') + '>')
} else {
  try {
    await scenarios[name]()
  } catch (error) {
    console.error('실패:', error.message)
    process.exitCode = 1
  }
}
process.exit()
