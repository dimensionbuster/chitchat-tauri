/**
 * TransferService: 룸 단위 파일 전송 (스웜 다운로드 + 서빙).
 *
 * 다운로드: 파일을 1MiB 구간으로 나눠, 그 파일을 가진 여러 피어에게 병렬로 요청한다.
 *  - 피어별 윈도우(동시 요청 수)를 AIMD로 조절한다: 성공하면 늘리고, 타임아웃이면 절반으로 줄인다.
 *  - 도착한 구간은 즉시 디스크에 쓰고 비트맵을 저장한다 (이어받기). 전체가 모이면 SHA-256을 검증한다.
 *  - 피어가 나가거나 멈추면 그 피어의 요청을 다른 피어에게 재배정하고, 반복 실패하는 피어는 잠시 제외한다.
 * 서빙: 요청받은 구간을 디스크에서 읽어 보낸다. 이 룸의 파일 목록에 있는 id만 알리고 제공한다.
 *
 * 연결 신뢰성(재전송/순서)은 WebRTC DataChannel이 보장한다. 여기서는 "어느 구간을 누구에게 받을지"만 다룬다.
 */

import type { JsonValue } from 'trystero'
import type { Mesh } from '../mesh'
import { createStore, type Store } from '../store'
import { blobs, segmentCount, segmentLength, SEGMENT_SIZE, progressStore } from './blobs'
import {
  CTL_CHANNEL,
  DATA_CHANNEL,
  MAX_SEGS_PER_WANT,
  isFileId,
  parseCtl,
  parseDataMeta,
  type CtlMessage,
} from './protocol'

export type TransferState = 'queued' | 'waiting' | 'active' | 'verifying' | 'done' | 'error'

export interface TransferInfo {
  id: string
  direction: 'download' | 'upload'
  name?: string
  size: number
  doneBytes: number
  state: TransferState
  /** 지금 데이터를 주고받는 피어 수 */
  peers: number
  /** bytes/sec (최근 5초) */
  speed: number
  error?: string
}

export interface TransferOptions {
  /** 이 룸의 파일 id들. 이 목록에 있는 것만 알리고 제공한다. */
  roomFileIds: () => Iterable<string>
}

export type DownloadRequest = { id: string; size: number; name?: string }

// --- 튜닝 상수 ---
const WINDOW_INIT = 3
const WINDOW_MIN = 2
const WINDOW_MAX = 24
/** 피어 한 곳에 미리 요청해 둘 양 = 그 피어의 처리량 x 이 시간 */
const WINDOW_TARGET_SECONDS = 4
const BATCH = 4
/** 이 시간 동안 그 피어에게서 바이트가 전혀 도착하지 않으면 멈춘 것으로 본다 (수신 진행 알림도 '도착'으로 친다) */
const PEER_STALL_MS = 30_000
const BAN_MS = 30_000
const BUSY_COOLDOWN_MS = 3_000
const MAX_FAILURES_BEFORE_BAN = 3
const MAX_ACTIVE_DOWNLOADS = 3
const MAX_VERIFY_RETRIES = 2
const SERVE_CONCURRENCY = 6
const SERVE_QUEUE_PER_PEER = 64
const SAVE_PROGRESS_EVERY_SEGS = 16
const EMIT_INTERVAL_MS = 150
const SPEED_WINDOW_MS = 5_000
const DONE_LINGER_MS = 4_000
const TICK_MS = 2_000

interface PeerStat {
  inflight: Set<number>
  window: number
  failures: number
  bannedUntil: number
  cooldownUntil: number
  lastDataAt: number
  /** 구간 완료 간격으로 잰 처리량(bytes/s, 지수이동평균). 0이면 아직 모름 */
  throughput: number
  /** 직전 구간 완료 시각 (처리량 계산용) */
  lastSegAt: number
}

interface Download {
  id: string
  size: number
  name?: string
  segTotal: number
  have: Uint8Array
  haveCount: number
  claimed: Map<number, string> // seg -> peerId
  /** 아직 도착 중인 구간의 수신 비율(0~1). 느린 링크에서도 진행률이 부드럽게 움직이도록 */
  partial: Map<number, number>
  peers: Map<string, PeerStat>
  state: TransferState
  error?: string
  samples: Array<{ t: number; bytes: number }>
  verifyRetries: number
  unsavedSegs: number
  finished: boolean
  finishedAt: number
  resolve: () => void
  reject: (error: Error) => void
  promise: Promise<void>
}

interface Upload {
  id: string
  size: number
  name?: string
  sentBytes: number
  queued: number
  peers: Set<string>
  samples: Array<{ t: number; bytes: number }>
  lastActivity: number
}

interface ServeJob {
  peerId: string
  id: string
  seg: number
}

export class TransferService {
  readonly transfers: Store<TransferInfo[]> = createStore<TransferInfo[]>([])

  private readonly ctl
  private readonly data
  private readonly owned = new Map<string, number>() // id -> size
  private readonly inventory = new Map<string, Set<string>>() // peerId -> ids
  private readonly downloads = new Map<string, Download>()
  private readonly uploads = new Map<string, Upload>()
  private readonly serveQueue: ServeJob[] = []
  private serving = 0
  private readonly servingPeers = new Set<string>() // 피어당 한 번에 한 구간만 보낸다 (완료가 앞당겨져 진행이 눈에 보인다)
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly tick: ReturnType<typeof setInterval>
  private readonly cleanups: Array<() => void> = []
  private destroyed = false

  constructor(
    private readonly mesh: Mesh,
    private readonly options: TransferOptions,
  ) {
    this.ctl = mesh.channel<JsonValue>(CTL_CHANNEL)
    this.data = mesh.channel<Uint8Array>(DATA_CHANNEL)

    this.cleanups.push(this.ctl.onMessage(m => this.onCtl(m.peerId, parseCtl(m.data))))
    this.cleanups.push(
      this.data.onMessage(m => {
        const meta = parseDataMeta(m.metadata)
        if (meta) void this.onSegment(m.peerId, meta.id, meta.seg, toBytes(m.data), meta.h)
      }),
    )
    this.cleanups.push(
      this.data.onProgress(p => {
        const meta = parseDataMeta(p.metadata)
        if (meta) this.onSegmentProgress(p.peerId, meta.id, meta.seg, p.progress)
      }),
    )

    const onJoin = (peerId: string) => this.onPeerJoin(peerId)
    const onLeave = (peerId: string) => this.onPeerLeave(peerId)
    mesh.on('peer-join', onJoin)
    mesh.on('peer-leave', onLeave)
    this.cleanups.push(() => mesh.off('peer-join', onJoin), () => mesh.off('peer-leave', onLeave))

    this.tick = setInterval(() => this.onTick(), TICK_MS)

    // 이미 연결된 피어에게도 인벤토리를 알린다 (서비스가 늦게 만들어진 경우)
    void this.loadOwned().then(() => this.mesh.peers.forEach(p => this.sendHave(p)))
  }

  // -------------------------------------------------------------------------
  // 공개 API
  // -------------------------------------------------------------------------

  isOwned(id: string): boolean {
    return this.owned.has(id)
  }

  /** 새로 보유하게 된 파일을 등록하고 피어에게 알린다 (업로드/가져오기 직후 호출). */
  announce(id: string, size: number) {
    if (!isFileId(id)) return
    this.owned.set(id, size)
    this.broadcast({ t: 'add', id })
  }

  /**
   * 파일을 받는다. 이미 있으면 바로 resolve. 같은 id를 여러 번 불러도 하나의 전송만 진행한다.
   * 피어가 없으면 'waiting'으로 대기하다가 보유 피어가 나타나면 자동으로 시작한다.
   */
  download(request: DownloadRequest): Promise<void> {
    const { id, size } = request
    if (!isFileId(id)) return Promise.reject(new Error('invalid-file-id'))
    if (this.owned.has(id)) return Promise.resolve()
    const existing = this.downloads.get(id)
    if (existing && !(existing.finished && existing.state === 'error')) return existing.promise
    if (existing) this.downloads.delete(id) // 실패한 전송은 새로 시작(부분 진행은 이어받는다)

    const segTotal = segmentCount(size)
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    // 아무도 await하지 않아도 unhandled rejection이 나지 않도록
    promise.catch(() => undefined)

    const d: Download = {
      id,
      size,
      name: request.name,
      segTotal,
      have: new Uint8Array(segTotal),
      haveCount: 0,
      claimed: new Map(),
      partial: new Map(),
      peers: new Map(),
      state: 'queued',
      samples: [],
      verifyRetries: 0,
      unsavedSegs: 0,
      finished: false,
      finishedAt: 0,
      resolve,
      reject,
      promise,
    }
    this.downloads.set(id, d)
    this.emitSoon()
    void this.startNext()
    return promise
  }

  cancel(id: string) {
    const d = this.downloads.get(id)
    if (!d || d.finished) return
    this.fail(d, new Error('cancelled'), 'error')
    this.downloads.delete(id)
    this.emitSoon()
  }

  /** 실패한 다운로드를 처음부터(이어받기 포함) 다시 시도한다. */
  retry(id: string) {
    const d = this.downloads.get(id)
    if (!d) return
    const { size, name } = d
    this.downloads.delete(id)
    void this.download({ id, size, name })
  }

  destroy() {
    this.destroyed = true
    clearInterval(this.tick)
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.cleanups.forEach(fn => fn())
    this.downloads.forEach(d => {
      if (!d.finished) this.fail(d, new Error('closed'), 'error')
    })
    this.downloads.clear()
    this.uploads.clear()
    this.serveQueue.length = 0
  }

  // -------------------------------------------------------------------------
  // 인벤토리 / 제어 메시지
  // -------------------------------------------------------------------------

  private async loadOwned() {
    try {
      const ids = await blobs.list()
      const roomIds = new Set(this.options.roomFileIds())
      for (const id of ids) {
        if (!isFileId(id) || !roomIds.has(id) || this.owned.has(id)) continue
        const status = await blobs.stat(id)
        if (status.state === 'complete') this.owned.set(id, status.size)
      }
    } catch (error) {
      console.warn('[Transfer] 보유 파일 조회 실패:', error)
    }
  }

  private ownedRoomIds(): string[] {
    const roomIds = new Set(this.options.roomFileIds())
    return Array.from(this.owned.keys()).filter(id => roomIds.has(id))
  }

  private sendHave(peerId: string) {
    this.sendCtl({ t: 'have', ids: this.ownedRoomIds() }, peerId)
  }

  private sendCtl(message: CtlMessage, target?: string) {
    this.ctl.send(message as unknown as JsonValue, target ? { target } : undefined).catch(() => {
      // 피어가 막 나간 경우. peer-leave 처리에서 정리된다.
    })
  }

  private broadcast(message: CtlMessage) {
    if (this.mesh.peers.size > 0) this.sendCtl(message)
  }

  private onPeerJoin(peerId: string) {
    this.sendHave(peerId)
  }

  private onPeerLeave(peerId: string) {
    this.inventory.delete(peerId)
    for (const d of this.downloads.values()) this.dropPeer(d, peerId)
    this.dropServing(peerId)
    this.downloads.forEach(d => this.pump(d))
    this.emitSoon()
  }

  private onCtl(peerId: string, message: CtlMessage | null) {
    if (!message || this.destroyed) return
    switch (message.t) {
      case 'have': {
        this.inventory.set(peerId, new Set(message.ids))
        this.downloads.forEach(d => this.pump(d))
        break
      }
      case 'add': {
        let ids = this.inventory.get(peerId)
        if (!ids) this.inventory.set(peerId, (ids = new Set()))
        ids.add(message.id)
        const d = this.downloads.get(message.id)
        if (d) this.pump(d)
        break
      }
      case 'want':
        this.onWant(peerId, message.id, message.segs)
        break
      case 'nack':
        this.onNack(peerId, message.id, message.segs, message.reason)
        break
      case 'cancel':
        this.serveQueue.splice(0, this.serveQueue.length, ...this.serveQueue.filter(j => !(j.peerId === peerId && j.id === message.id)))
        break
    }
  }

  // -------------------------------------------------------------------------
  // 서빙
  // -------------------------------------------------------------------------

  private onWant(peerId: string, id: string, segs: number[]) {
    const size = this.owned.get(id)
    const roomIds = new Set(this.options.roomFileIds())
    if (size === undefined || !roomIds.has(id)) {
      this.sendCtl({ t: 'nack', id, segs, reason: 'missing' }, peerId)
      return
    }
    const total = segmentCount(size)
    const valid = segs.filter(s => s < total).slice(0, MAX_SEGS_PER_WANT)
    const queuedForPeer = this.serveQueue.filter(j => j.peerId === peerId).length
    if (queuedForPeer + valid.length > SERVE_QUEUE_PER_PEER) {
      this.sendCtl({ t: 'nack', id, segs: valid, reason: 'busy' }, peerId)
      return
    }
    let upload = this.uploads.get(id)
    if (!upload) {
      upload = { id, size, sentBytes: 0, queued: 0, peers: new Set(), samples: [], lastActivity: Date.now() }
      this.uploads.set(id, upload)
    }
    upload.queued += valid.length
    upload.peers.add(peerId)
    upload.lastActivity = Date.now()
    for (const seg of valid) this.serveQueue.push({ peerId, id, seg })
    this.pumpServe()
    this.emitSoon()
  }

  private dropServing(peerId: string) {
    const kept = this.serveQueue.filter(j => j.peerId !== peerId)
    const dropped = this.serveQueue.length - kept.length
    if (dropped > 0) {
      this.serveQueue.splice(0, this.serveQueue.length, ...kept)
    }
    this.uploads.forEach(u => u.peers.delete(peerId))
  }

  private pumpServe() {
    while (this.serving < SERVE_CONCURRENCY && !this.destroyed) {
      const index = this.serveQueue.findIndex(j => !this.servingPeers.has(j.peerId))
      if (index < 0) return
      const [job] = this.serveQueue.splice(index, 1)
      if (!job) return
      this.serving++
      this.servingPeers.add(job.peerId)
      void this.serveOne(job).finally(() => {
        this.serving--
        this.servingPeers.delete(job.peerId)
        this.pumpServe()
      })
    }
  }

  private async serveOne(job: ServeJob) {
    const upload = this.uploads.get(job.id)
    const size = this.owned.get(job.id)
    try {
      if (size === undefined) throw new Error('missing')
      const len = segmentLength(size, job.seg)
      const bytes = await blobs.read(job.id, job.seg * SEGMENT_SIZE, len)
      if (bytes.length !== len) throw new Error('short-read')
      if (!this.mesh.peers.has(job.peerId)) return
      const h = await segmentHash(bytes)
      await this.data.send(bytes, { target: job.peerId, metadata: { id: job.id, seg: job.seg, h } })
      if (upload) {
        upload.sentBytes += len
        upload.samples.push({ t: Date.now(), bytes: len })
        upload.lastActivity = Date.now()
      }
    } catch (error) {
      if (this.mesh.peers.has(job.peerId)) {
        this.sendCtl({ t: 'nack', id: job.id, segs: [job.seg], reason: 'error' }, job.peerId)
      }
      console.warn('[Transfer] 구간 전송 실패:', job.id.slice(0, 8), job.seg, error instanceof Error ? error.message : error)
    } finally {
      if (upload) upload.queued = Math.max(0, upload.queued - 1)
      this.emitSoon()
    }
  }

  // -------------------------------------------------------------------------
  // 다운로드
  // -------------------------------------------------------------------------

  private activeCount(): number {
    let n = 0
    this.downloads.forEach(d => {
      if (!d.finished && d.state !== 'queued') n++
    })
    return n
  }

  private async startNext() {
    for (const d of this.downloads.values()) {
      if (this.activeCount() >= MAX_ACTIVE_DOWNLOADS) return
      if (d.finished || d.state !== 'queued') continue
      d.state = 'waiting'
      await this.initDownload(d)
    }
  }

  private async initDownload(d: Download) {
    try {
      const status = await blobs.begin(d.id, d.size)
      if (status.state === 'complete') {
        this.complete(d)
        return
      }
      if (status.state === 'partial') {
        const saved = await progressStore.load(d.id, d.segTotal)
        if (saved) {
          d.have = saved
          d.haveCount = saved.reduce((n, b) => n + (b ? 1 : 0), 0)
        }
      }
      if (d.haveCount >= d.segTotal) {
        await this.finalize(d)
        return
      }
      this.pump(d)
    } catch (error) {
      this.fail(d, error instanceof Error ? error : new Error(String(error)), 'error')
    }
    this.emitSoon()
  }

  /** 디스크에 쓴 내용을 flush한 뒤에 비트맵을 저장한다 (비트맵이 디스크보다 앞서지 않도록). */
  private async persist(d: Download) {
    try {
      await blobs.sync(d.id)
      await progressStore.save(d.id, d.have)
    } catch {
      // 저장 실패는 치명적이지 않다: 최악의 경우 이어받기 정보를 잃고 해당 구간을 다시 받는다.
    }
  }

  private peerStat(d: Download, peerId: string): PeerStat {
    let stat = d.peers.get(peerId)
    if (!stat) {
      stat = { inflight: new Set(), window: WINDOW_INIT, failures: 0, bannedUntil: 0, cooldownUntil: 0, lastDataAt: Date.now(), throughput: 0, lastSegAt: Date.now() }
      d.peers.set(peerId, stat)
    }
    return stat
  }

  /** 아직 받지도, 요청 중이지도 않은 구간들 중 앞쪽부터 최대 n개 */
  private nextMissing(d: Download, n: number): number[] {
    const out: number[] = []
    for (let i = 0; i < d.segTotal && out.length < n; i++) {
      if (!d.have[i] && !d.claimed.has(i)) out.push(i)
    }
    return out
  }

  /** 가능한 피어에게 가능한 만큼 구간을 요청한다. 이벤트가 있을 때마다 호출해도 안전하다(멱등). */
  private pump(d: Download) {
    if (d.finished || d.state === 'queued' || d.state === 'verifying' || this.destroyed) return
    const now = Date.now()

    const candidates = Array.from(this.mesh.peers).filter(peerId => {
      if (!this.inventory.get(peerId)?.has(d.id)) return false
      const stat = d.peers.get(peerId)
      return !stat || (stat.bannedUntil <= now && stat.cooldownUntil <= now)
    })

    if (candidates.length === 0) {
      if (d.claimed.size === 0 && d.state !== 'waiting') {
        d.state = 'waiting'
        this.emitSoon()
      }
      return
    }

    for (const peerId of candidates) {
      const stat = this.peerStat(d, peerId)
      while (stat.inflight.size < stat.window) {
        const room = Math.min(BATCH, stat.window - stat.inflight.size)
        const segs = this.nextMissing(d, room)
        if (segs.length === 0) break
        if (stat.inflight.size === 0) stat.lastSegAt = now
        for (const seg of segs) {
          d.claimed.set(seg, peerId)
          stat.inflight.add(seg)
        }
        stat.lastDataAt = stat.inflight.size === segs.length ? now : stat.lastDataAt
        this.sendCtl({ t: 'want', id: d.id, segs }, peerId)
      }
    }
    if (d.claimed.size > 0 && d.state !== 'active') {
      d.state = 'active'
      this.emitSoon()
    }
  }

  /** 구간이 도착하는 도중: 피어가 살아 있다는 신호이자 부드러운 진행률의 원천 */
  private onSegmentProgress(peerId: string, id: string, seg: number, fraction: number) {
    const d = this.downloads.get(id)
    const stat = d?.peers.get(peerId)
    if (!d || !stat || d.finished || d.claimed.get(seg) !== peerId) return
    stat.lastDataAt = Date.now()
    d.partial.set(seg, Math.min(1, Math.max(0, fraction)))
    this.emitSoon()
  }

  private async onSegment(peerId: string, id: string, seg: number, bytes: Uint8Array, hash?: string) {
    const d = this.downloads.get(id)
    if (!d || d.finished || d.state === 'verifying') return
    const stat = d.peers.get(peerId)
    if (!stat || d.claimed.get(seg) !== peerId || seg >= d.segTotal) return // 요청하지 않았거나 늦게 도착한 구간

    if (bytes.length !== segmentLength(d.size, seg)) {
      this.rejectSegment(d, peerId, seg, `잘못된 구간 크기 ${bytes.length}`)
      return
    }
    // 구간 단위 무결성: 전송/상대 디스크 손상을 파일 전체가 아니라 이 구간만 다시 받아 해결한다
    if (hash && (await segmentHash(bytes)) !== hash) {
      this.rejectSegment(d, peerId, seg, '구간 해시 불일치')
      return
    }
    if (d.finished) return

    try {
      await blobs.write(id, seg * SEGMENT_SIZE, bytes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.fail(d, new Error(message.includes('no-space') ? 'no-space' : `disk-write: ${message}`), 'error')
      return
    }
    if (d.finished) return

    const now = Date.now()
    stat.inflight.delete(seg)
    stat.lastDataAt = now
    stat.failures = 0
    // 처리량(EWMA)으로 윈도우를 정한다: 빠른 피어에겐 많이, 느린 피어에겐 적게 걸어 둔다
    const sample = bytes.length / Math.max(0.05, (now - stat.lastSegAt) / 1000)
    stat.throughput = stat.throughput === 0 ? sample : stat.throughput * 0.7 + sample * 0.3
    stat.lastSegAt = now
    stat.window = Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, Math.ceil((stat.throughput * WINDOW_TARGET_SECONDS) / SEGMENT_SIZE)))
    d.claimed.delete(seg)
    d.partial.delete(seg)
    if (!d.have[seg]) {
      d.have[seg] = 1
      d.haveCount++
      d.unsavedSegs++
      d.samples.push({ t: now, bytes: bytes.length })
    }

    if (d.unsavedSegs >= SAVE_PROGRESS_EVERY_SEGS) {
      d.unsavedSegs = 0
      void this.persist(d)
    }

    if (d.haveCount >= d.segTotal) {
      await this.finalize(d)
    } else {
      this.pump(d)
    }
    this.emitSoon()
  }

  /** 이 구간만 거부하고 다시 요청 대상으로 되돌린다. 반복되면 그 피어를 잠시 제외한다. */
  private rejectSegment(d: Download, peerId: string, seg: number, reason: string) {
    const stat = d.peers.get(peerId)
    d.claimed.delete(seg)
    d.partial.delete(seg)
    if (stat) {
      stat.inflight.delete(seg)
      stat.failures++
      if (stat.failures >= MAX_FAILURES_BEFORE_BAN) {
        stat.bannedUntil = Date.now() + BAN_MS
        stat.failures = 0
        console.warn(`[Transfer] 피어 ${peerId.slice(0, 6)} 제외 (${reason}):`, d.id.slice(0, 8))
      }
    }
    console.warn(`[Transfer] 구간 거부 (${reason}):`, d.id.slice(0, 8), seg)
    this.pump(d)
  }

  private onNack(peerId: string, id: string, segs: number[], reason: 'missing' | 'busy' | 'error') {
    const d = this.downloads.get(id)
    if (!d || d.finished) return
    const stat = d.peers.get(peerId)
    for (const seg of segs) {
      if (d.claimed.get(seg) === peerId) d.claimed.delete(seg)
      stat?.inflight.delete(seg)
    }
    if (reason === 'missing') {
      this.inventory.get(peerId)?.delete(id) // 이 피어는 더 이상 이 파일이 없다
    } else if (stat) {
      if (reason === 'busy') {
        stat.cooldownUntil = Date.now() + BUSY_COOLDOWN_MS
        stat.window = Math.max(WINDOW_MIN, Math.floor(stat.window / 2))
      } else {
        this.penalize(d, peerId, '피어 오류')
      }
    }
    this.pump(d)
    if (reason === 'busy') setTimeout(() => this.pump(d), BUSY_COOLDOWN_MS + 50)
  }

  /** 피어가 실패했다: 그 피어의 요청을 되돌리고, 반복되면 잠시 제외한다. */
  private penalize(d: Download, peerId: string, reason: string) {
    const stat = d.peers.get(peerId)
    if (!stat) return
    stat.failures++
    stat.window = Math.max(WINDOW_MIN, Math.floor(stat.window / 2))
    this.releaseClaims(d, peerId)
    if (stat.failures >= MAX_FAILURES_BEFORE_BAN) {
      stat.bannedUntil = Date.now() + BAN_MS
      stat.failures = 0
      console.warn(`[Transfer] 피어 ${peerId.slice(0, 6)} 제외 (${reason}):`, d.id.slice(0, 8))
    }
  }

  private releaseClaims(d: Download, peerId: string) {
    const stat = d.peers.get(peerId)
    for (const [seg, owner] of d.claimed) {
      if (owner === peerId) {
        d.claimed.delete(seg)
        d.partial.delete(seg)
      }
    }
    stat?.inflight.clear()
  }

  private dropPeer(d: Download, peerId: string) {
    this.releaseClaims(d, peerId)
    d.peers.delete(peerId)
  }

  private onTick() {
    const now = Date.now()
    for (const d of this.downloads.values()) {
      if (d.finished) continue
      // 데이터가 오지 않는 피어는 멈춘 것으로 보고 요청을 되돌린다.
      for (const [peerId, stat] of d.peers) {
        if (stat.inflight.size > 0 && now - stat.lastDataAt > PEER_STALL_MS) {
          this.penalize(d, peerId, '응답 없음')
          stat.lastDataAt = now
        }
      }
      this.pump(d)
    }
    // 끝난 전송 표시를 잠시 뒤 정리 (실패는 사용자가 재시도/닫을 때까지 유지)
    for (const [id, d] of this.downloads) {
      if (d.state === 'done' && now - d.finishedAt > DONE_LINGER_MS) this.downloads.delete(id)
    }
    for (const [id, u] of this.uploads) {
      if (u.queued === 0 && now - u.lastActivity > DONE_LINGER_MS) this.uploads.delete(id)
    }
    this.emitSoon()
  }

  private async finalize(d: Download) {
    if (d.finished || d.state === 'verifying') return
    d.state = 'verifying'
    this.emitSoon()
    try {
      await blobs.finalize(d.id, d.id)
      this.complete(d)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('hash-mismatch') && d.verifyRetries < MAX_VERIFY_RETRIES) {
        // 손상: 처음부터 다시 받는다
        d.verifyRetries++
        console.warn('[Transfer] 해시 불일치, 재시도', d.verifyRetries, d.id.slice(0, 8))
        await blobs.remove(d.id).catch(() => undefined)
        await progressStore.clear(d.id).catch(() => undefined)
        d.have = new Uint8Array(d.segTotal)
        d.haveCount = 0
        d.claimed.clear()
        d.peers.clear()
        try {
          await blobs.begin(d.id, d.size)
        } catch (beginError) {
          this.fail(d, beginError instanceof Error ? beginError : new Error(String(beginError)), 'error')
          return
        }
        d.state = 'waiting'
        this.pump(d)
      } else {
        this.fail(d, new Error(message.startsWith('hash-mismatch') ? 'corrupt' : message), 'error')
      }
    }
    this.emitSoon()
  }

  private complete(d: Download) {
    d.finished = true
    d.finishedAt = Date.now()
    d.state = 'done'
    d.haveCount = d.segTotal
    d.samples.push({ t: Date.now(), bytes: 0 })
    this.owned.set(d.id, d.size)
    void progressStore.clear(d.id).catch(() => undefined)
    this.broadcast({ t: 'add', id: d.id })
    this.peersOf(d).forEach(peerId => this.sendCtl({ t: 'cancel', id: d.id }, peerId))
    d.resolve()
    this.emitSoon()
  }

  private fail(d: Download, error: Error, state: TransferState) {
    if (d.finished) return
    d.finished = true
    d.finishedAt = Date.now()
    d.state = state
    d.error = error.message
    d.samples.push({ t: Date.now(), bytes: 0 })
    void this.persist(d) // 부분 진행은 남겨 두어 재시도 시 이어받는다
    this.peersOf(d).forEach(peerId => this.sendCtl({ t: 'cancel', id: d.id }, peerId))
    d.reject(error)
    this.emitSoon()
  }

  private peersOf(d: Download): string[] {
    return Array.from(d.peers.keys()).filter(p => this.mesh.peers.has(p))
  }

  // -------------------------------------------------------------------------
  // UI용 상태
  // -------------------------------------------------------------------------

  private speedOf(samples: Array<{ t: number; bytes: number }>): number {
    const cutoff = Date.now() - SPEED_WINDOW_MS
    while (samples.length > 0 && samples[0]!.t < cutoff) samples.shift()
    if (samples.length === 0) return 0
    const total = samples.reduce((n, s) => n + s.bytes, 0)
    return total / (SPEED_WINDOW_MS / 1000)
  }

  private emitSoon() {
    if (this.emitTimer || this.destroyed) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.transfers.set(this.snapshot())
    }, EMIT_INTERVAL_MS)
  }

  private partialBytes(d: Download): number {
    let bytes = 0
    for (const [seg, fraction] of d.partial) bytes += fraction * segmentLength(d.size, seg)
    return bytes
  }

  private snapshot(): TransferInfo[] {
    const list: TransferInfo[] = []
    for (const d of this.downloads.values()) {
      const active = Array.from(d.peers.values()).filter(s => s.inflight.size > 0).length
      list.push({
        id: d.id,
        direction: 'download',
        name: d.name,
        size: d.size,
        doneBytes: Math.min(d.size, d.haveCount * SEGMENT_SIZE + this.partialBytes(d)),
        state: d.state,
        peers: active,
        speed: d.state === 'active' ? this.speedOf(d.samples) : 0,
        error: d.error,
      })
    }
    for (const u of this.uploads.values()) {
      list.push({
        id: u.id,
        direction: 'upload',
        name: u.name,
        size: u.size,
        doneBytes: Math.min(u.size, u.sentBytes),
        state: u.queued > 0 ? 'active' : 'done',
        peers: u.peers.size,
        speed: this.speedOf(u.samples),
      })
    }
    return list
  }
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

/** 구간 내용 SHA-256의 앞 16바이트(hex). 구간 단위 무결성 검사용. */
async function segmentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  let out = ''
  for (let i = 0; i < 16; i++) out += digest[i]!.toString(16).padStart(2, '0')
  return out
}
