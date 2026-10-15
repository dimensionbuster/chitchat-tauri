/**
 * TrysteroProvider: Mesh 위에서 동작하는 Yjs provider.
 *
 * 피어가 들어오면 Yjs sync step 1(내 state vector)을 보내고, 상대는 step 2(내게 없는 업데이트)로
 * 응답한다. 이후 변경은 update로 전파한다. awareness(접속자 상태)도 같은 채널로 교환한다.
 * 연결 자체는 Mesh가 관리하므로 여기서는 문서/awareness 프로토콜만 다룬다.
 *
 * 이벤트: 'peers'({ added, removed, webrtcPeers }), 'status'({ connected }), 'synced'({ synced })
 */

import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { Observable } from 'lib0/observable'
import type { Channel } from './mesh'
import type { Mesh } from './mesh'

const MSG_SYNC = 0
const MSG_AWARENESS = 1

export class TrysteroProvider extends Observable<string> {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  synced = false

  private readonly channel: Channel<Uint8Array>
  private readonly unsubscribe: Array<() => void> = []
  /** peerId -> 그 피어가 소유한 awareness clientID들 (퇴장 시 정리용) */
  private peerClients = new Map<string, Set<number>>()

  constructor(
    readonly mesh: Mesh,
    doc: Y.Doc,
    awareness?: awarenessProtocol.Awareness,
  ) {
    super()
    this.doc = doc
    this.awareness = awareness ?? new awarenessProtocol.Awareness(doc)
    this.channel = mesh.channel<Uint8Array>('y')

    this.unsubscribe.push(this.channel.onMessage(({ data, peerId }) => this.onMessage(toBytes(data), peerId)))

    const onJoin = (peerId: string) => this.onPeerJoin(peerId)
    const onLeave = (peerId: string) => this.onPeerLeave(peerId)
    const onStatus = (status: { connected: boolean }) => {
      if (!status.connected) this.setSynced(false)
      this.emit('status', [status])
    }
    mesh.on('peer-join', onJoin)
    mesh.on('peer-leave', onLeave)
    mesh.on('status', onStatus)
    this.unsubscribe.push(
      () => mesh.off('peer-join', onJoin),
      () => mesh.off('peer-leave', onLeave),
      () => mesh.off('status', onStatus),
    )

    doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this.onUnload)
  }

  get connected(): boolean {
    return this.mesh.connected
  }

  get peerIds(): string[] {
    return Array.from(this.mesh.peers)
  }

  connect() {
    this.mesh.connect()
  }

  disconnect() {
    this.mesh.disconnect()
  }

  override destroy() {
    this.unsubscribe.forEach(fn => fn())
    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this.onUnload)
    super.destroy()
  }

  private onUnload = () => {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload')
  }

  private setSynced(synced: boolean) {
    if (this.synced === synced) return
    this.synced = synced
    this.emit('synced', [{ synced }])
  }

  private send(enc: encoding.Encoder, target?: string) {
    this.channel.send(encoding.toUint8Array(enc), target ? { target } : undefined).catch(error => {
      // 피어가 막 나간 경우 등. 다음 상태 교환에서 복구되므로 로그만 남긴다.
      console.warn('[Provider] 전송 실패:', error instanceof Error ? error.message : error)
    })
  }

  private onPeerJoin(peerId: string) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, this.doc)
    this.send(enc, peerId)

    const clients = Array.from(this.awareness.getStates().keys())
    if (clients.length > 0) {
      const aenc = encoding.createEncoder()
      encoding.writeVarUint(aenc, MSG_AWARENESS)
      encoding.writeVarUint8Array(aenc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients))
      this.send(aenc, peerId)
    }

    this.emit('peers', [{ added: [peerId], removed: [], webrtcPeers: this.peerIds }])
  }

  private onPeerLeave(peerId: string) {
    const clients = this.peerClients.get(peerId)
    if (clients) {
      awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(clients), this)
      this.peerClients.delete(peerId)
    }
    this.emit('peers', [{ added: [], removed: [peerId], webrtcPeers: this.peerIds }])
  }

  private onMessage(data: Uint8Array, peerId: string) {
    try {
      const decoder = decoding.createDecoder(data)
      const type = decoding.readVarUint(decoder)

      if (type === MSG_SYNC) {
        const reply = encoding.createEncoder()
        encoding.writeVarUint(reply, MSG_SYNC)
        const syncType = syncProtocol.readSyncMessage(decoder, reply, this.doc, this)
        if (encoding.length(reply) > 1) this.send(reply, peerId)
        if (syncType === syncProtocol.messageYjsSyncStep2) this.setSynced(true)
      } else if (type === MSG_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder)
        this.trackClients(peerId, update)
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this)
      }
    } catch (error) {
      // 깨진/악의적 메시지 하나가 전체 동기화를 막지 않도록 버린다.
      console.warn('[Provider] 잘못된 메시지 무시:', error instanceof Error ? error.message : error)
    }
  }

  /** awareness 업데이트에서 clientID만 읽어 피어와 연결해 둔다. */
  private trackClients(peerId: string, update: Uint8Array) {
    const dec = decoding.createDecoder(update)
    const len = decoding.readVarUint(dec)
    let clients = this.peerClients.get(peerId)
    if (!clients) this.peerClients.set(peerId, (clients = new Set()))
    for (let i = 0; i < len; i++) {
      clients.add(decoding.readVarUint(dec))
      decoding.readVarUint(dec) // clock
      decoding.readVarString(dec) // state json
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.mesh.peers.size === 0) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    this.send(enc)
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this || this.mesh.peers.size === 0) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed)),
    )
    this.send(enc)
  }
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}
