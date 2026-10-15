/**
 * Room core (프레임워크 독립)
 *
 * 채팅방 하나의 P2P 상태를 조립한다:
 *   Y.Doc(CRDT) + IndexedDB 영속화 + Mesh(피어 연결) + TrysteroProvider(문서 동기화) + TransferService(파일)
 * 메시지 정렬(하이브리드 Lamport)도 여기서 한다. UI 프레임워크는 import하지 않고, 반응형 값은 Store로 노출한다.
 *
 * 로컬에 저장된 기록은 네트워크를 기다리지 않고 즉시 보여준다. 피어 동기화는 백그라운드에서 진행된다.
 */

import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { ChatMessage, FileMeta } from '@/types/types'
import { Mesh } from './mesh'
import { TrysteroProvider } from './provider'
import { TransferService } from './net/transfer'
import { createStore, type Store } from './store'

export interface InitialSyncState {
  syncing: boolean
  progress: string
}

export interface NetStatus {
  connected: boolean
  /** 연결된 피어 수 */
  peers: number
  /** 이번 연결에서 피어로부터 문서 동기화를 한 번이라도 받았는가 */
  synced: boolean
}

/** 모든 룸에 공통인 로딩 상태 (래퍼 화면의 오버레이용) */
export const globalSyncState = createStore<InitialSyncState>({ syncing: false, progress: '' })

const DEFAULT_VISIBLE_MESSAGES = 50
const LOAD_MORE_COUNT = 30
const SORT_DEBOUNCE_MS = 100 // 100ms 내 여러 변경을 한 번에 정렬
const TIME_WINDOW = 60_000 // 1분 이내는 Lamport로 인과 순서 보장
const FIRST_SYNC_WAIT_MS = 5000 // 로컬 기록이 없을 때 첫 동기화를 기다리는 최대 시간

const rooms = new Map<string, Promise<Room>>()

export type Room = Awaited<ReturnType<typeof createRoomInstance>>

async function createRoomInstance(roomId: string) {
  const doc = new Y.Doc({ gc: true })

  const syncState = createStore<InitialSyncState>({ syncing: true, progress: '' })
  const setSyncState = (syncing: boolean, progress?: string) => {
    const next = { syncing, progress: progress ?? syncState.get().progress }
    syncState.set(next)
    globalSyncState.set(next)
  }
  setSyncState(true, '초기화 중...')

  // 마이그레이션: Y.Array → Y.Map (기존 데이터 있으면 자동 전환)
  const oldMessages = doc.getArray<ChatMessage>('messages')
  const messagesMap = doc.getMap<ChatMessage>('messagesMap')
  const files = doc.getMap<FileMeta>('files')

  // Lamport 논리적 시계 (메시지 순서 보장)
  let lamportClock = 0
  const tickLamport = () => ++lamportClock

  let sortedMessages: ChatMessage[] = []
  let visibleMessageCount = DEFAULT_VISIBLE_MESSAGES
  const messages: Store<ChatMessage[]> = createStore<ChatMessage[]>([])

  const sortMessages = (msgs: ChatMessage[]) =>
    msgs.sort((a, b) => {
      // 1분 이상 차이면 물리적 시간, 이내면 Lamport, 최종 결정자는 시간 → ID
      if (Math.abs(a.ts - b.ts) > TIME_WINDOW) return a.ts - b.ts
      if (a.lamport !== b.lamport) return a.lamport - b.lamport
      if (a.ts !== b.ts) return a.ts - b.ts
      return a.id.localeCompare(b.id)
    })

  const publishVisible = () => {
    messages.set(sortedMessages.slice(-visibleMessageCount))
  }

  const updateSortedMessages = () => {
    const all = Array.from(messagesMap.values())
    for (const msg of all) {
      if (msg.lamport > lamportClock) lamportClock = msg.lamport
    }
    sortedMessages = sortMessages(all)
    publishVisible()
  }

  let sortTimeout: ReturnType<typeof setTimeout> | null = null
  messagesMap.observe(() => {
    if (sortTimeout) clearTimeout(sortTimeout)
    sortTimeout = setTimeout(updateSortedMessages, SORT_DEBOUNCE_MS)
  })

  console.log('[#1] Room 초기화: IndexedDB 로드 중...')
  const persistence = new IndexeddbPersistence(`ydb-${roomId}`, doc)

  await new Promise<void>(resolve => {
    persistence.once('synced', () => {
      if (oldMessages.length > 0 && messagesMap.size === 0) {
        doc.transact(() => {
          oldMessages.toArray().forEach((msg, index) => {
            const messageId = msg.id || `${msg.ts}-${crypto.randomUUID()}`
            const existingLamport = 'lamport' in msg ? (msg as ChatMessage).lamport : undefined
            messagesMap.set(messageId, { ...msg, id: messageId, lamport: existingLamport ?? index })
          })
        })
      }

      // Lamport 값이 없는 기존 메시지에 타임스탬프 순서로 부여
      const missing: [string, ChatMessage][] = []
      messagesMap.forEach((msg, id) => {
        if (!('lamport' in msg)) missing.push([id, msg])
      })
      if (missing.length > 0) {
        doc.transact(() => {
          missing.sort((a, b) => a[1].ts - b[1].ts)
          missing.forEach(([id, msg], index) => messagesMap.set(id, { ...msg, lamport: index }))
        })
        console.log(`[#2-1] Lamport 마이그레이션: ${missing.length}개 메시지 업데이트`)
      }

      updateSortedMessages()
      console.log(`[#2] IndexedDB 로드 완료: 메시지 ${messagesMap.size}개, 파일 ${files.size}개`)
      resolve()
    })
  })

  // --- 네트워크 조립 (연결은 openRoom에서 시작) ---
  const mesh = new Mesh(`doc:${roomId}`)
  const provider = new TrysteroProvider(mesh, doc)
  const transfers = new TransferService(mesh, { roomFileIds: () => files.keys() })

  const net = createStore<NetStatus>({ connected: false, peers: 0, synced: false })
  const refreshNet = () => net.set({ connected: mesh.connected, peers: mesh.peers.size, synced: provider.synced })
  mesh.on('status', refreshNet)
  mesh.on('peer-join', refreshNet)
  mesh.on('peer-leave', refreshNet)
  provider.on('synced', refreshNet)

  const sendTextMessage = (authorTrueUuid: string, authorName: string, text: string) => {
    if (!text.trim()) return
    const ts = Date.now()
    const id = `${ts}-${crypto.randomUUID()}`
    messagesMap.set(id, { id, authorTrueUuid, authorName, text, ts, lamport: tickLamport() })
  }

  /** 파일 메시지를 올린다. fileId는 파일 내용의 SHA-256이며, 보유 사실은 전송 서비스에 알린다. */
  const attachFileMeta = (fileId: string, meta: FileMeta, authorTrueUuid: string, authorName = authorTrueUuid) => {
    doc.transact(() => {
      files.set(fileId, meta)
      const ts = Date.now()
      const id = `${ts}-${crypto.randomUUID()}`
      messagesMap.set(id, { id, authorTrueUuid, authorName, fileId, ts, lamport: tickLamport() })
    })
    if (typeof meta.size === 'number') transfers.announce(fileId, meta.size)
  }

  const loadMoreMessages = () => {
    if (visibleMessageCount >= sortedMessages.length) return false
    visibleMessageCount = Math.min(visibleMessageCount + LOAD_MORE_COUNT, sortedMessages.length)
    publishVisible()
    return true
  }

  const resetToLatest = () => {
    visibleMessageCount = DEFAULT_VISIBLE_MESSAGES
    publishVisible()
  }

  const isViewingLatest = () =>
    visibleMessageCount === DEFAULT_VISIBLE_MESSAGES || visibleMessageCount >= sortedMessages.length

  const exportSnapshot = () => Y.encodeStateAsUpdate(doc)
  const importSnapshot = (snapshot: Uint8Array) => Y.applyUpdate(doc, snapshot)

  /** 연결을 끊었다 다시 맺는다 (절전 복귀, 네트워크 변경 후). 문서 상태는 유지된다. */
  const reconnect = () => {
    mesh.disconnect()
    mesh.connect()
  }

  const forceResync = async () => {
    try {
      transfers.destroy()
      provider.destroy()
      mesh.destroy()
      doc.transact(() => {
        messagesMap.clear()
        files.clear()
      })
      await persistence.clearData()
      persistence.destroy()
      rooms.delete(roomId)
      doc.destroy()
      console.log('[Room] 재동기화 완료')
      return true
    } catch (error) {
      console.error('[Room] 재동기화 실패:', error)
      return false
    }
  }

  return {
    doc,
    mesh,
    provider,
    transfers,
    persistence,
    messagesMap,
    files,
    messages,
    syncState,
    net,
    setSyncState,
    sendTextMessage,
    attachFileMeta,
    loadMoreMessages,
    resetToLatest,
    isViewingLatest,
    reconnect,
    forceResync,
    exportSnapshot,
    importSnapshot,
  }
}

function setUserAwareness(provider: TrysteroProvider, userUuid?: string, nickname?: string) {
  const state = { ...(provider.awareness.getLocalState() || {}) } as Record<string, unknown>
  if (userUuid) state.userUuid = userUuid
  if (nickname) {
    state.nickname = nickname
    state.user = { uuid: userUuid || state.userUuid, nickname }
  }
  provider.awareness.setLocalState(state)
}

/**
 * 룸을 열고(없으면 생성) 사용자 정보를 설정한다.
 * userUuid가 있으면 피어 연결을 시작한다. 로컬 기록이 있으면 네트워크를 기다리지 않는다.
 */
export async function openRoom(roomId: string, userUuid?: string, nickname?: string): Promise<Room> {
  const cached = rooms.get(roomId)
  if (cached) {
    const room = await cached
    setUserAwareness(room.provider, userUuid, nickname)
    if (userUuid && !room.mesh.connected) room.mesh.connect()
    return room
  }

  const promise = createRoomInstance(roomId)
  rooms.set(roomId, promise)
  const room = await promise
  setUserAwareness(room.provider, userUuid, nickname)

  if (!userUuid) {
    room.setSyncState(false, '')
    return room
  }

  const hadLocalHistory = room.messagesMap.size > 0
  room.mesh.connect()

  if (hadLocalHistory) {
    room.setSyncState(false, '')
  } else {
    // 처음 들어온 방: 기록을 받을 때까지(또는 피어가 없다고 판단될 때까지) 잠깐 기다린다.
    room.setSyncState(true, '피어를 찾는 중...')
    await new Promise<void>(resolve => {
      const done = () => {
        room.provider.off('synced', onSynced)
        clearTimeout(timer)
        resolve()
      }
      const onSynced = (event: { synced: boolean }) => {
        if (event.synced) done()
      }
      const timer = setTimeout(done, FIRST_SYNC_WAIT_MS)
      room.provider.on('synced', onSynced)
    })
    room.setSyncState(false, '')
  }
  return room
}
