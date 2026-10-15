export type ChatMessage = {
  id: string
  authorTrueUuid: string
  authorName: string
  ts: number // 로컬 타임스탬프 (표시용)
  lamport: number // 논리적 시계 (정렬용)
  text?: string
  fileId?: string // 파일 내용의 SHA-256 (소문자 hex)
}

export type FileMeta = {
  name?: string
  size?: number
  type?: string
  /** 'avatar'면 프로필 사진용 파일 (채팅 메시지로 보이지 않는다) */
  kind?: string
  // allow extra metadata fields
  [key: string]: unknown
}

export type ChatroomOption = {
  theme: 'light' | 'dark'
  fontSize: number
  showTimestamps: boolean
  showNotifications: boolean
  soundEffects: boolean
  [key: string]: unknown // 확장 가능
}

