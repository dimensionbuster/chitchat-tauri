/**
 * Mesh: Trystero 룸 하나를 감싸는 피어 메시.
 *
 * 한 룸의 모든 피어와 WebRTC 연결을 맺고, 그 위에 이름 붙은 채널(액션)을 여러 개 제공한다.
 * Yjs 동기화와 파일 전송이 같은 연결을 공유한다 (피어마다 연결 1개).
 * 재연결(disconnect → connect)해도 등록한 채널과 핸들러는 유지된다.
 */

import { joinRoom, type Room, type MessageAction, type DataPayload, type JsonValue } from 'trystero'
import { Observable } from 'lib0/observable'
import { TRYSTERO_APP_ID, RTC_CONFIG, MAX_RECEIVE_BYTES, loadTurnConfig } from './config'

export type ChannelMessage<T extends DataPayload> = {
  data: T
  peerId: string
  metadata?: JsonValue
}

export type ChannelProgress = {
  peerId: string
  /** 0~1: 아직 도착 중인 메시지 하나의 수신 진행률 */
  progress: number
  metadata?: JsonValue
}

export interface Channel<T extends DataPayload> {
  /** target이 없으면 모든 피어에게 보낸다. 전송이 끝나면(버퍼에 다 들어가면) resolve. */
  send(data: T, options?: { target?: string; metadata?: JsonValue }): Promise<void>
  onMessage(handler: (message: ChannelMessage<T>) => void): () => void
  /** 큰 메시지가 도착하는 도중의 진행 알림. 느린 링크에서 "아직 살아 있음"을 판단하는 데 쓴다. */
  onProgress(handler: (progress: ChannelProgress) => void): () => void
}

export type PeerPath = {
  /** 선택된 ICE 후보 쌍의 종류. relay면 TURN을 경유 중. */
  localType?: string
  remoteType?: string
  protocol?: string
  rttMs?: number
}

class ChannelImpl<T extends DataPayload> implements Channel<T> {
  private action: MessageAction<T> | null = null
  private handlers = new Set<(message: ChannelMessage<T>) => void>()
  private progressHandlers = new Set<(progress: ChannelProgress) => void>()

  constructor(private readonly name: string) {}

  bind(room: Room) {
    const action = room.makeAction<T>(this.name)
    action.onMessage = (data, ctx) => {
      const message = { data, peerId: ctx.peerId, metadata: ctx.metadata }
      this.handlers.forEach(h => {
        try {
          h(message)
        } catch (error) {
          console.error(`[Mesh] ${this.name} 핸들러 오류:`, error)
        }
      })
    }
    action.onReceiveProgress = (progress, ctx) => {
      const normalized = progress > 1 ? progress / 100 : progress
      this.progressHandlers.forEach(h => h({ peerId: ctx.peerId, progress: normalized, metadata: ctx.metadata }))
    }
    this.action = action
  }

  unbind() {
    this.action = null
  }

  send(data: T, options?: { target?: string; metadata?: JsonValue }): Promise<void> {
    if (!this.action) return Promise.reject(new Error('mesh-disconnected'))
    return this.action.send(data, {
      ...(options?.target ? { target: options.target } : {}),
      ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    })
  }

  onMessage(handler: (message: ChannelMessage<T>) => void) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onProgress(handler: (progress: ChannelProgress) => void) {
    this.progressHandlers.add(handler)
    return () => this.progressHandlers.delete(handler)
  }
}

/**
 * 이벤트: 'peer-join'(peerId), 'peer-leave'(peerId), 'status'({ connected })
 */
export class Mesh extends Observable<string> {
  readonly roomName: string
  private room: Room | null = null
  private channels = new Map<string, ChannelImpl<DataPayload>>()
  private peerSet = new Set<string>()

  constructor(roomName: string) {
    super()
    this.roomName = roomName
  }

  get connected(): boolean {
    return this.room !== null
  }

  get peers(): ReadonlySet<string> {
    return this.peerSet
  }

  /** 채널은 connect 전후 어느 때든 만들 수 있다. 같은 이름이면 같은 채널을 돌려준다. */
  channel<T extends DataPayload>(name: string): Channel<T> {
    let channel = this.channels.get(name)
    if (!channel) {
      channel = new ChannelImpl<DataPayload>(name)
      this.channels.set(name, channel)
      if (this.room) channel.bind(this.room)
    }
    return channel as unknown as Channel<T>
  }

  connect() {
    if (this.room) return
    const turnConfig = loadTurnConfig()
    const room = joinRoom(
      {
        appId: TRYSTERO_APP_ID,
        rtcConfig: RTC_CONFIG,
        maxReceiveBytes: MAX_RECEIVE_BYTES,
        ...(turnConfig ? { turnConfig } : {}),
      },
      this.roomName,
    )
    this.room = room
    this.channels.forEach(c => c.bind(room))

    room.onPeerJoin = peerId => {
      this.peerSet.add(peerId)
      console.log('[Mesh] peer join', peerId, this.roomName)
      this.emit('peer-join', [peerId])
    }
    room.onPeerLeave = peerId => {
      this.peerSet.delete(peerId)
      console.log('[Mesh] peer leave', peerId, this.roomName)
      this.emit('peer-leave', [peerId])
    }
    this.emit('status', [{ connected: true }])
  }

  disconnect() {
    if (!this.room) return
    const room = this.room
    this.room = null
    this.channels.forEach(c => c.unbind())
    void room.leave()
    const left = Array.from(this.peerSet)
    this.peerSet.clear()
    left.forEach(peerId => this.emit('peer-leave', [peerId]))
    this.emit('status', [{ connected: false }])
  }

  /** 피어와의 실제 연결 경로(직접/NAT 통과/TURN)와 RTT. 진단·UI 표시용. */
  async getPeerPath(peerId: string): Promise<PeerPath | null> {
    const pc = this.room?.getPeers()[peerId]
    if (!pc) return null
    try {
      const stats = await pc.getStats()
      let pairId: string | undefined
      stats.forEach(report => {
        if (report.type === 'transport' && report.selectedCandidatePairId) pairId = report.selectedCandidatePairId
      })
      let pair: RTCIceCandidatePairStats | undefined
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && (report.id === pairId || (!pairId && report.nominated && report.state === 'succeeded'))) {
          pair = report as RTCIceCandidatePairStats
        }
      })
      if (!pair) return null
      const local = stats.get(pair.localCandidateId) as { candidateType?: string; protocol?: string } | undefined
      const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined
      return {
        localType: local?.candidateType,
        remoteType: remote?.candidateType,
        protocol: local?.protocol,
        rttMs: pair.currentRoundTripTime !== undefined ? Math.round(pair.currentRoundTripTime * 1000) : undefined,
      }
    } catch {
      return null
    }
  }

  override destroy() {
    this.disconnect()
    super.destroy()
  }
}
