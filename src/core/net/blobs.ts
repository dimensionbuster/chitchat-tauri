/**
 * 블롭 저장소 클라이언트 (Rust blobs.rs의 얇은 래퍼).
 * 파일은 SHA-256 해시를 id로 디스크에 저장된다. 이 모듈은 실제 바이트를 JS 힙에 오래 들고 있지 않는다.
 */

import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type BlobState = 'complete' | 'partial' | 'new'
export type BlobStatus = { state: BlobState; size: number }
export type ImportedBlob = { id: string; size: number; name: string }

/** 수신 구간 크기. 요청/재전송/디스크 쓰기의 기본 단위. */
export const SEGMENT_SIZE = 1024 * 1024

export function segmentCount(size: number): number {
  return Math.ceil(size / SEGMENT_SIZE)
}

export function segmentLength(size: number, index: number): number {
  return Math.min(SEGMENT_SIZE, size - index * SEGMENT_SIZE)
}

export const blobs = {
  begin: (id: string, size: number) => invoke<BlobStatus>('blob_begin', { id, size }),

  /** `.part` 파일의 offset 위치에 바이트를 쓴다. */
  write: (id: string, offset: number, bytes: Uint8Array) =>
    invoke<void>('blob_write', bytes, { headers: { 'x-id': id, 'x-offset': String(offset) } }),

  read: async (id: string, offset: number, len: number): Promise<Uint8Array> =>
    new Uint8Array(await invoke<ArrayBuffer>('blob_read', { id, offset, len })),

  /** 해시를 검증해 확정한다. 불일치면 'hash-mismatch:<actual>' 오류. */
  finalize: (id: string, expected?: string) =>
    invoke<string>('blob_finalize', { id, expected: expected ?? null, adopt: false }),

  /** 지금까지 쓴 내용을 디스크에 flush */
  sync: (id: string) => invoke<void>('blob_sync', { id }),

  stat: (id: string) => invoke<BlobStatus>('blob_stat', { id }),
  path: (id: string) => invoke<string | null>('blob_path', { id }),
  remove: (id: string) => invoke<void>('blob_delete', { id }),
  list: () => invoke<string[]>('blob_list'),
  gc: (keep: string[], maxPartAgeSecs: number) => invoke<number>('blob_gc', { keep, maxPartAgeSecs }),

  /** 완성된 블롭을 <img>/<video>에 바로 쓸 수 있는 URL로. 없으면 null. */
  async url(id: string): Promise<string | null> {
    const path = await blobs.path(id)
    return path ? convertFileSrc(path) : null
  },

  /** 디스크의 파일을 가져온다 (Rust가 복사하며 해시 계산). */
  importPath: (path: string) => invoke<ImportedBlob>('blob_import_path', { path }),

  saveAs: (id: string, suggestedName: string) => invoke<string | null>('blob_save_as', { id, suggestedName }),
}

/**
 * 브라우저 File(드래그앤드롭/입력)을 저장소로 가져온다. 구간 단위로 스트리밍해 메모리를 아낀다.
 * 임시 id로 쓰고, 끝에 해시를 계산해 확정한다.
 */
export async function importFile(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportedBlob> {
  const tmpId = `imp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  await blobs.begin(tmpId, file.size)
  try {
    const count = Math.max(1, segmentCount(file.size))
    for (let i = 0; i < count; i++) {
      const start = i * SEGMENT_SIZE
      const chunk = new Uint8Array(await file.slice(start, start + SEGMENT_SIZE).arrayBuffer())
      if (chunk.length > 0) await blobs.write(tmpId, start, chunk)
      onProgress?.(Math.min(start + SEGMENT_SIZE, file.size), file.size)
    }
    // adopt: 해시를 id로 삼아 확정
    const id = await invoke<string>('blob_finalize', { id: tmpId, expected: null, adopt: true })
    return { id, size: file.size, name: file.name }
  } catch (error) {
    await blobs.remove(tmpId).catch(() => undefined)
    throw error
  }
}

export type BlobProgressEvent = { op: 'import' | 'verify'; id: string; done: number; total: number }

export function onBlobProgress(handler: (event: BlobProgressEvent) => void): Promise<() => void> {
  return listen<BlobProgressEvent>('blob-progress', e => handler(e.payload))
}

/** 이어받기용 구간 비트맵(구간당 1바이트)을 앱 데이터에 저장한다. */
export const progressStore = {
  name: (id: string) => `dl-${id}.bin`,

  save(id: string, have: Uint8Array) {
    return invoke<void>('store_write', have, { headers: { 'x-name': progressStore.name(id) } })
  },

  async load(id: string, segTotal: number): Promise<Uint8Array | null> {
    try {
      const bytes = new Uint8Array(await invoke<ArrayBuffer>('store_read', { name: progressStore.name(id) }))
      return bytes.length === segTotal ? bytes : null
    } catch (error) {
      if (error === 'not-found') return null
      throw error
    }
  },

  clear(id: string) {
    return invoke<void>('store_remove', { name: progressStore.name(id) })
  },
}

/** 메모리에 이미 있는 작은 바이트(썸네일 등)를 저장소로 가져온다. */
export async function importBytes(bytes: Uint8Array, name: string): Promise<ImportedBlob> {
  const tmpId = `imp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  await blobs.begin(tmpId, bytes.length)
  try {
    if (bytes.length > 0) await blobs.write(tmpId, 0, bytes)
    const id = await invoke<string>('blob_finalize', { id: tmpId, expected: null, adopt: true })
    return { id, size: bytes.length, name }
  } catch (error) {
    await blobs.remove(tmpId).catch(() => undefined)
    throw error
  }
}
