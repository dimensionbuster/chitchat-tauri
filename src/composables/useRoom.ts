/**
 * useRoom: core/room의 Vue 바인딩.
 * 로직은 core에 있고, 여기서는 Store를 Vue ref로 변환한다.
 */
import { computed } from 'vue'
import { openRoom, globalSyncState } from '@/core/room'
import { useStore } from './useStore'

// 래퍼 화면의 로딩 오버레이용 전역 상태 (모듈 수명 동안 유지)
const globalSync = useStore(globalSyncState)
export const globalIsInitialSyncing = computed(() => globalSync.value.syncing)
export const globalInitialSyncProgress = computed(() => globalSync.value.progress)

export async function useRoom(roomId = 'default-room', userUuid?: string, nickname?: string) {
  const room = await openRoom(roomId, userUuid, nickname)
  const messagesRef = useStore(room.messages)
  const syncState = useStore(room.syncState)
  const net = useStore(room.net)
  const transfers = useStore(room.transfers.transfers)

  // 시험(네트워크 랩 등)용 디버그 핸들. 개발 모드이거나 localStorage 'chitchat-debug'=1일 때만 노출한다.
  if (import.meta.env.DEV || localStorage.getItem('chitchat-debug') === '1') {
    ;(window as unknown as { __room?: unknown }).__room = room
  }

  return { ...room, messagesRef, syncState, net, transferList: transfers }
}
