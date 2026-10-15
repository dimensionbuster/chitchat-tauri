// Trystero 룸 네임스페이스. 값이 다르면 서로 연결되지 않는다.
export const TRYSTERO_APP_ID = 'chitchat-dimension-v1'

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:3478' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
  iceCandidatePoolSize: 10,
}

/** 한 번에 받을 수 있는 최대 메시지 크기(합계). 파일 구간(1MiB) 여러 개와 Yjs 상태 전체가 들어간다. */
export const MAX_RECEIVE_BYTES = 64 * 1024 * 1024

export type TurnEntry = { urls: string | string[]; username?: string; credential?: string }

/**
 * 선택 사항: TURN 릴레이. 기본값은 비어 있어서 순수 P2P로만 연결한다(대칭 NAT 등에서는 연결되지 않을 수 있다).
 * 직접 운영하는 TURN이 있다면 localStorage 'chitchat-turn'에 JSON 배열로 넣는다.
 * 예: [{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
 */
export function loadTurnConfig(): TurnEntry[] | undefined {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('chitchat-turn') : null
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return undefined
    const valid = parsed.filter(
      (e): e is TurnEntry => !!e && typeof e === 'object' && (typeof (e as TurnEntry).urls === 'string' || Array.isArray((e as TurnEntry).urls)),
    )
    return valid.length > 0 ? valid : undefined
  } catch {
    return undefined
  }
}
