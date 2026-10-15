/**
 * useFileTransferProgress
 *
 * 전송 상태 조회용 브리지. 실제 전송은 core/net/transfer의 TransferService가 하고,
 * 여기서는 그 상태 스토어를 화면 컴포넌트가 쓰기 쉬운 형태(파일 id로 조회)로 노출한다.
 * 룸이 열릴 때 useRoom이 bindTransfers로 스토어를 연결한다.
 */

import { computed, ref, shallowRef } from 'vue'
import type { Store } from '@/core/store'
import type { TransferInfo } from '@/core/net/transfer'

export interface FileTransferProgress {
  fileId: string
  fileName: string
  type: 'upload' | 'download'
  totalBytes: number
  receivedBytes: number
  isComplete: boolean
  /** queued | waiting | active | verifying | done | error */
  state: TransferInfo['state']
  /** 데이터를 주고받는 피어 수 */
  peers: number
  /** bytes/sec */
  speed: number
  error?: string
}

/** 디스크로 가져오는 중인 로컬 파일 (해시 계산 포함) */
export interface ImportingFile {
  name: string
  done: number
  total: number
}

const list = shallowRef<TransferInfo[]>([])
const importing = ref<ImportingFile | null>(null)
const names = new Map<string, string>() // fileId -> 표시 이름 (업로드 항목용)
let unsubscribe: (() => void) | null = null

/** 현재 룸의 전송 상태 스토어를 연결한다 (이전 연결은 해제). */
export function bindTransfers(store: Store<TransferInfo[]>, resolveName?: (fileId: string) => string | undefined) {
  unsubscribe?.()
  const apply = (value: TransferInfo[]) => {
    if (resolveName) {
      for (const t of value) {
        const name = t.name ?? resolveName(t.id)
        if (name) names.set(t.id, name)
      }
    }
    list.value = value
  }
  apply(store.get())
  unsubscribe = store.subscribe(apply)
}

export function setImporting(info: ImportingFile | null) {
  importing.value = info
}

const byId = computed(() => {
  const map = new Map<string, FileTransferProgress>()
  for (const t of list.value) {
    const key = t.direction === 'download' ? t.id : `up:${t.id}`
    map.set(key, {
      fileId: t.id,
      fileName: t.name ?? names.get(t.id) ?? t.id.slice(0, 8),
      type: t.direction,
      totalBytes: t.size,
      receivedBytes: t.doneBytes,
      isComplete: t.state === 'done',
      state: t.state,
      peers: t.peers,
      speed: t.speed,
      error: t.error,
    })
  }
  return map
})

export function useFileTransferProgress() {
  /** 다운로드 진행 상태 (없으면 undefined) */
  const getProgress = (fileId: string) => byId.value.get(fileId)

  const getProgressPercent = (fileId: string) => {
    const t = byId.value.get(fileId)
    if (!t || t.totalBytes === 0) return 0
    return Math.min((t.receivedBytes / t.totalBytes) * 100, 100)
  }

  const isTransferring = (fileId: string) => {
    const t = byId.value.get(fileId)
    return !!t && t.state !== 'done' && t.state !== 'error'
  }

  return {
    transfers: computed(() => Array.from(byId.value.values())),
    importing,
    getProgress,
    getProgressPercent,
    isTransferring,
  }
}
