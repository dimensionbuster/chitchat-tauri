/**
 * 파일 전송 프로토콜 (Mesh 채널 위).
 *
 * - 'ft-ctl'  : 작은 JSON 제어 메시지
 * - 'ft-data' : 구간(segment) 바이너리. metadata = { id, seg }
 *
 * 파일 id는 내용의 SHA-256(소문자 hex 64자). 받은 쪽은 완료 후 해시를 검증하므로 출처를 신뢰할 필요가 없다.
 */

import type { JsonValue } from 'trystero'

export const CTL_CHANNEL = 'ft-ctl'
export const DATA_CHANNEL = 'ft-data'

export type CtlMessage =
  /** 접속 시 내 보유 파일 목록 (이 룸의 파일만) */
  | { t: 'have'; ids: string[] }
  /** 새로 보유하게 된 파일 */
  | { t: 'add'; id: string }
  /** 구간 요청 */
  | { t: 'want'; id: string; segs: number[] }
  /** 요청을 처리할 수 없음 */
  | { t: 'nack'; id: string; segs: number[]; reason: 'missing' | 'busy' | 'error' }
  /** 진행 중인 요청 취소 */
  | { t: 'cancel'; id: string }

/** h: 구간 내용 SHA-256의 앞 16바이트(hex 32자). 전송/디스크 손상을 구간 단위로 잡아낸다. */
export type DataMeta = { id: string; seg: number; h?: string }

export const MAX_SEGS_PER_WANT = 16
export const MAX_HAVE_IDS = 50_000

const ID_RE = /^[0-9a-f]{64}$/

export function isFileId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

/** 외부에서 온 값을 검증해 CtlMessage로 좁힌다. 규격에 맞지 않으면 null. */
export function parseCtl(value: unknown): CtlMessage | null {
  if (!value || typeof value !== 'object') return null
  const m = value as Record<string, unknown>
  switch (m.t) {
    case 'have':
      if (!Array.isArray(m.ids) || m.ids.length > MAX_HAVE_IDS || !m.ids.every(isFileId)) return null
      return { t: 'have', ids: m.ids as string[] }
    case 'add':
      return isFileId(m.id) ? { t: 'add', id: m.id } : null
    case 'want':
      if (!isFileId(m.id) || !isSegList(m.segs)) return null
      return { t: 'want', id: m.id, segs: m.segs }
    case 'nack':
      if (!isFileId(m.id) || !isSegList(m.segs)) return null
      if (m.reason !== 'missing' && m.reason !== 'busy' && m.reason !== 'error') return null
      return { t: 'nack', id: m.id, segs: m.segs, reason: m.reason }
    case 'cancel':
      return isFileId(m.id) ? { t: 'cancel', id: m.id } : null
    default:
      return null
  }
}

function isSegList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SEGS_PER_WANT &&
    value.every(n => Number.isInteger(n) && n >= 0 && n < 1e9)
  )
}

export function parseDataMeta(value: JsonValue | undefined): DataMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { id, seg, h } = value as Record<string, unknown>
  if (!isFileId(id) || !Number.isInteger(seg) || (seg as number) < 0) return null
  if (h !== undefined && (typeof h !== 'string' || !/^[0-9a-f]{32}$/.test(h))) return null
  return { id, seg: seg as number, ...(typeof h === 'string' ? { h } : {}) }
}
