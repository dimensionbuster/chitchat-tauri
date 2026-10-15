/**
 * useRoomFiles
 *
 * 채팅방의 파일 동작을 화면용으로 묶는다: 업로드, 이미지 자동 로드, 저장.
 * 실제 전송/저장은 core(TransferService, 디스크 블롭)가 하고, 이 파일은 그것을 호출하고 UI 상태만 만든다.
 */

import { ref } from 'vue'
import type { ChatMessage, FileMeta } from '@/types/types'
import type { Room } from '@/core/room'
import { blobs, importFile } from '@/core/net/blobs'
import { setImporting } from './useFileTransferProgress'

/** 이 크기 이하의 이미지는 보이면 자동으로 받는다. 그 이상은 사용자가 누를 때 받는다. */
export const AUTO_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024

export function useRoomFiles(room: Pick<Room, 'files' | 'transfers'>) {
  const { files, transfers } = room

  const imageUrls = ref(new Map<string, string>()) // fileId -> 화면에 쓸 수 있는 URL
  const loadingImages = ref(new Set<string>())
  const failedDownloads = ref(new Map<string, string>())

  const isImage = (fileId: string) => files.get(fileId)?.type?.startsWith('image/') ?? false

  /** 로컬 파일을 가져와(해시 계산) 파일 id와 메타를 만든다. 아직 메시지로 올리진 않는다. */
  async function prepareFile(file: File): Promise<{ fileId: string; meta: FileMeta }> {
    setImporting({ name: file.name, done: 0, total: file.size })
    try {
      const imported = await importFile(file, (done, total) => setImporting({ name: file.name, done, total }))
      const meta: FileMeta = { name: file.name, size: file.size, type: file.type || 'application/octet-stream' }
      return { fileId: imported.id, meta }
    } finally {
      setImporting(null)
    }
  }

  /** 파일이 이 기기에 없으면 피어에게서 받는다. 이미 있으면 바로 끝난다. */
  async function ensureFile(fileId: string): Promise<void> {
    const meta = files.get(fileId)
    if (!meta || typeof meta.size !== 'number') throw new Error('파일 메타데이터를 찾을 수 없습니다')
    await transfers.download({ id: fileId, size: meta.size, name: meta.name })
  }

  /** 이미지 URL을 준비한다. force면 이전 실패를 지우고 다시 시도한다. */
  async function downloadImage(fileId: string, force = false) {
    if (imageUrls.value.has(fileId)) return
    if (loadingImages.value.has(fileId)) return
    if (force) failedDownloads.value.delete(fileId)

    loadingImages.value.add(fileId)
    try {
      await ensureFile(fileId)
      const url = await blobs.url(fileId)
      if (!url) throw new Error('파일을 읽을 수 없습니다')
      imageUrls.value.set(fileId, url)
      failedDownloads.value.delete(fileId)
    } catch (error) {
      failedDownloads.value.set(fileId, error instanceof Error ? error.message : '알 수 없는 오류')
    } finally {
      loadingImages.value.delete(fileId)
    }
  }

  /** 화면에 보이는 메시지들의 이미지를 준비한다: 이미 있으면 바로, 작으면 자동으로 받는다. */
  async function processAutoDownload(messages: readonly ChatMessage[]) {
    for (const msg of messages) {
      const id = msg.fileId
      if (!id || !isImage(id)) continue
      if (imageUrls.value.has(id) || loadingImages.value.has(id) || failedDownloads.value.has(id)) continue

      const local = transfers.isOwned(id)
      const small = (files.get(id)?.size ?? Infinity) <= AUTO_DOWNLOAD_MAX_BYTES
      if (local || small) void downloadImage(id)
    }
  }

  /** 파일을 (필요하면 받아서) 사용자가 고른 위치에 저장한다. */
  async function downloadFile(fileId: string) {
    const meta = files.get(fileId)
    if (!meta) return
    await ensureFile(fileId)
    await blobs.saveAs(fileId, meta.name ?? fileId)
  }

  return {
    imageUrls,
    loadingImages,
    failedDownloads,
    isImage,
    prepareFile,
    ensureFile,
    downloadImage,
    processAutoDownload,
    downloadFile,
  }
}
