/**
 * useProfilePicture
 *
 * 프로필 사진: 썸네일(작게 압축)과 원본을 각각 해시 id의 블롭으로 디스크에 저장한다.
 * 방에서는 awareness에 해시만 실어 알리고, 상대는 필요할 때 일반 파일 전송으로 받는다.
 * 마지막으로 본 상대의 프로필은 로컬에 기억해 두어 오프라인이어도 바로 보인다.
 */

import { ref, reactive, computed } from 'vue'
import type { Room } from '@/core/room'
import { blobs, importBytes, importFile } from '@/core/net/blobs'
import {
  PROFILE_PICTURE_MAX_SIZE,
  PROFILE_PICTURE_QUALITY,
  PROFILE_PICTURE_MAX_BYTES,
} from './fileConstants'
import { showAlert } from './useCustomDialog'

type BlobRef = { id: string; size: number }
type ProfileRecord = { userId: string; thumb: BlobRef; original?: BlobRef; ts: number }
type ProfileAwareness = { userId: string; thumb?: BlobRef; original?: BlobRef; ts: number; removed?: boolean }

const MY_PROFILE_KEY = 'my-profile'
const PROFILE_INDEX_KEY = 'profile-index'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn('[ProfilePicture] 저장 실패:', error)
  }
}

/** 이미지를 정사각 한도 안으로 줄이고 JPEG로 압축한다. 크기 한도를 넘으면 품질을 낮춘다. */
async function makeThumbnail(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, PROFILE_PICTURE_MAX_SIZE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas context not available')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    let quality = PROFILE_PICTURE_QUALITY
    let blob = await toBlob(canvas, quality)
    while (blob.size > PROFILE_PICTURE_MAX_BYTES && quality > 0.1) {
      quality -= 0.1
      blob = await toBlob(canvas, quality)
    }
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    bitmap.close()
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/jpeg', quality)
  })
}

type ProfileRoom = Pick<Room, 'files' | 'transfers' | 'provider'>

export function useProfilePicture(room: ProfileRoom | null, myUserId: string) {
  /** userId -> 화면에 쓸 이미지 URL */
  const profilePictures = reactive(new Map<string, string>())
  const myProfilePicture = ref<string | null>(null)

  const index = readJson<Record<string, ProfileRecord>>(PROFILE_INDEX_KEY, {})
  const originals = new Map<string, BlobRef>() // userId -> 원본 참조

  const getUserProfilePicture = computed(() => (userId: string): string | null => profilePictures.get(userId) ?? null)

  const getProfileOriginalFileId = async (userId: string): Promise<string | null> => {
    const mine = readJson<ProfileRecord | null>(MY_PROFILE_KEY, null)
    if (userId === myUserId) return mine?.original?.id ?? null
    return originals.get(userId)?.id ?? index[userId]?.original?.id ?? null
  }

  async function showThumb(userId: string, thumbId: string) {
    const url = await blobs.url(thumbId)
    if (url) {
      profilePictures.set(userId, url)
      if (userId === myUserId) myProfilePicture.value = url
    }
  }

  /** 방의 파일 목록에 등록하고 보유 사실을 알린다 (상대가 받아갈 수 있도록). */
  function registerInRoom(ref: BlobRef, name: string, type: string) {
    if (!room) return
    if (!room.files.has(ref.id)) room.files.set(ref.id, { name, size: ref.size, type, kind: 'avatar' })
    room.transfers.announce(ref.id, ref.size)
  }

  function publishMine(record: ProfileRecord | null) {
    if (!room) return
    if (!record) {
      const removed: ProfileAwareness = { userId: myUserId, ts: Date.now(), removed: true }
      room.provider.awareness.setLocalStateField('profilePicture', removed)
      return
    }
    registerInRoom(record.thumb, 'profile-thumb.jpg', 'image/jpeg')
    if (record.original) registerInRoom(record.original, 'profile-original', 'image/*')
    const state: ProfileAwareness = { userId: myUserId, thumb: record.thumb, original: record.original, ts: record.ts }
    room.provider.awareness.setLocalStateField('profilePicture', state)
  }

  const setMyProfilePicture = async (file: File): Promise<void> => {
    const [thumbBytes, original] = await Promise.all([makeThumbnail(file), importFile(file)])
    const thumb = await importBytes(thumbBytes, 'profile-thumb.jpg')
    const record: ProfileRecord = {
      userId: myUserId,
      thumb: { id: thumb.id, size: thumb.size },
      original: { id: original.id, size: original.size },
      ts: Date.now(),
    }
    writeJson(MY_PROFILE_KEY, record)
    await showThumb(myUserId, record.thumb.id)
    publishMine(record)
    console.log(`[ProfilePicture] 설정 완료: 썸네일 ${thumb.size}B, 원본 ${original.size}B`)
  }

  const deleteMyProfilePicture = async (): Promise<void> => {
    localStorage.removeItem(MY_PROFILE_KEY)
    myProfilePicture.value = null
    profilePictures.delete(myUserId)
    publishMine(null)
  }

  /** 상대가 알린 프로필을 반영한다: 새 것이면 썸네일을 받아 표시하고 기억해 둔다. */
  async function applyRemote(state: ProfileAwareness) {
    const { userId } = state
    if (!userId || userId === myUserId) return
    if (state.removed || !state.thumb) {
      if (!index[userId] || state.ts >= index[userId]!.ts) {
        delete index[userId]
        originals.delete(userId)
        profilePictures.delete(userId)
        writeJson(PROFILE_INDEX_KEY, index)
      }
      return
    }
    const known = index[userId]
    if (known && known.ts >= state.ts && profilePictures.has(userId)) return

    if (state.original) originals.set(userId, state.original)
    try {
      await room!.transfers.download({ id: state.thumb.id, size: state.thumb.size, name: 'profile-thumb.jpg' })
      await showThumb(userId, state.thumb.id)
      index[userId] = { userId, thumb: state.thumb, original: state.original, ts: state.ts }
      writeJson(PROFILE_INDEX_KEY, index)
    } catch (error) {
      console.warn(`[ProfilePicture] ${userId.slice(-8)} 썸네일 받기 실패:`, error instanceof Error ? error.message : error)
    }
  }

  /** 앱/방 시작 시 한 번: 내 프로필과 기억해 둔 상대 프로필을 불러오고, 방이면 변경을 구독한다. */
  const initializeProfilePictures = async (): Promise<void> => {
    const mine = readJson<ProfileRecord | null>(MY_PROFILE_KEY, null)
    if (mine) {
      await showThumb(myUserId, mine.thumb.id)
      publishMine(mine)
    }
    if (!room) return

    for (const record of Object.values(index)) {
      if (record.userId === myUserId) continue
      if (record.original) originals.set(record.userId, record.original)
      void showThumb(record.userId, record.thumb.id)
    }

    const scan = () => {
      for (const [, state] of room.provider.awareness.getStates()) {
        const profile = (state as Record<string, unknown>).profilePicture as ProfileAwareness | undefined
        if (profile?.userId) void applyRemote(profile)
      }
    }
    room.provider.awareness.on('change', scan)
    scan()
  }

  const createProfileHandlers = () => ({
    handleUpload: async (file: File): Promise<void> => {
      try {
        await setMyProfilePicture(file)
        await showAlert('프로필 사진이 설정되었습니다.')
      } catch (error) {
        console.error('[ProfilePicture] 업로드 실패:', error)
        await showAlert('프로필 사진 설정에 실패했습니다.')
      }
    },
    handleDelete: async (): Promise<void> => {
      try {
        await deleteMyProfilePicture()
        await showAlert('프로필 사진이 삭제되었습니다.')
      } catch (error) {
        console.error('[ProfilePicture] 삭제 실패:', error)
        await showAlert('프로필 사진 삭제에 실패했습니다.')
      }
    },
  })

  return {
    myProfilePicture,
    profilePictures,
    getUserProfilePicture,
    setMyProfilePicture,
    deleteMyProfilePicture,
    initializeProfilePictures,
    getProfileOriginalFileId,
    createProfileHandlers,
  }
}
