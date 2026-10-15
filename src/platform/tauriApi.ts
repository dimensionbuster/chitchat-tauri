/**
 * Tauri 어댑터: 기존 Electron preload가 노출하던 `window.electronApi`와 같은 모양의 API를
 * Tauri 커맨드/이벤트 위에 구현한다. 화면 코드는 그대로 두고 이 파일만 플랫폼에 맞춘다.
 * 창/트레이/다이얼로그/파일 저장은 src-tauri(Rust)가 담당한다.
 */

import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getVersion } from '@tauri-apps/api/app'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ElectronApi } from '@/types/window'
import { installTitlebar } from './titlebar'
import { checkForUpdate, startAutoUpdate } from './updater'

type BackgroundType = 'home' | 'chat' | 'notification'
type NotificationSettings = { volume: number; enabled: boolean }

const NOTIFICATION_SETTINGS_FILE = 'notification-settings.json'
const STYLE_SETTINGS_FILE = 'style-settings.json'
const CUSTOM_SOUND_FILE = 'custom-sound.mp3'
const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { volume: 0.5, enabled: true }

// ---------------------------------------------------------------------------
// 파일 저장 헬퍼
// ---------------------------------------------------------------------------

async function storeWrite(name: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  await invoke('store_write', bytes, { headers: { 'x-name': name } })
}

async function storeRead(name: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await invoke<ArrayBuffer>('store_read', { name }))
  } catch (error) {
    if (error === 'not-found') return null
    throw error
  }
}

async function storeReadJson<T>(name: string, fallback: T): Promise<T> {
  const bytes = await storeRead(name)
  if (!bytes) return fallback
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    return fallback
  }
}

async function storeWriteJson(name: string, value: unknown): Promise<void> {
  await storeWrite(name, new TextEncoder().encode(JSON.stringify(value, null, 2)))
}

function toDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }))
  })
}

async function pickFile(title: string, filterName: string, extensions: string[]): Promise<ArrayBuffer | null> {
  try {
    return await invoke<ArrayBuffer>('pick_file', { title, filterName, extensions })
  } catch (error) {
    if (error === 'cancelled') return null
    console.error('[tauriApi] pick_file failed:', error)
    return null
  }
}

async function guarded<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    console.error(`[tauriApi] ${label} failed:`, error)
    return fallback
  }
}

async function patchNotificationSettings(patch: Partial<NotificationSettings>): Promise<void> {
  const current = await storeReadJson(NOTIFICATION_SETTINGS_FILE, DEFAULT_NOTIFICATION_SETTINGS)
  await storeWriteJson(NOTIFICATION_SETTINGS_FILE, { ...current, ...patch })
}

// ---------------------------------------------------------------------------
// 절전 복귀 감지
// Tauri에는 powerMonitor가 없어서 타이머 간격이 비정상적으로 벌어지면 복귀로 간주한다.
// ---------------------------------------------------------------------------

const resumeCallbacks = new Set<() => void>()
let resumeWatcherStarted = false

function startResumeWatcher() {
  if (resumeWatcherStarted) return
  resumeWatcherStarted = true
  const TICK_MS = 5000
  const GAP_MS = 20000
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    if (now - last > GAP_MS) {
      console.log('[tauriApi] 절전 복귀 감지')
      resumeCallbacks.forEach(cb => cb())
    }
    last = now
  }, TICK_MS)
}

// ---------------------------------------------------------------------------
// API 구성
// ---------------------------------------------------------------------------

export function createTauriApi(): ElectronApi {
  const bgFile = (type: BackgroundType) => `${type}-background.png`

  return {
    // 알림
    newChatMessage: payload => {
      void invoke('create_notification', {
        authorName: payload.authorName,
        text: payload.text,
        messageId: payload.messageId ?? '',
        roomId: '',
      })
    },
    createNotification: (authorName, text, messageId, roomId) => {
      void invoke('create_notification', { authorName, text, messageId, roomId })
    },
    closeNotification: () => void invoke('close_notification'),
    clickNotification: (roomId, userName) => void invoke('click_notification', { roomId, userName }),

    // 로깅
    sendLogMessage: (level, message) => {
      const fn = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error
      fn(`[${level.toUpperCase()}]`, message)
    },

    // 창 제어
    windowMinimize: () => void invoke('window_minimize'),
    windowMaximize: () => void invoke('window_maximize'),
    windowClose: () => void invoke('window_close'),
    windowDestroy: () => void invoke('window_destroy'),
    openChatRoom: (roomId, userName) => void invoke('open_chat_room', { roomId, userName }),
    showMainWindow: () => void invoke('show_main_window'),
    openSettings: () => void invoke('open_settings'),
    openWatchParty: (roomId, youtubeUrl, userName) =>
      void invoke('open_watch_party', { roomId, youtubeUrl, userName }),
    sendWatchPartyCommand: (command, data) => {
      void emit('watch-party:execute-command', { command, data })
    },
    openExternal: url => void invoke('open_external', { url }),

    // 커스텀 다이얼로그
    showDialog: async message => {
      await invoke('show_dialog', { message, kind: 'alert' })
    },
    showConfirm: message =>
      guarded('showConfirm', () => invoke<boolean>('show_dialog', { message, kind: 'confirm' }), false),
    closeDialog: (dialogId, result) => void invoke('close_dialog', { dialogId, result }),
    resizeAndShowDialog: (dialogId, width, height) =>
      void invoke('resize_and_show_dialog', { dialogId, width, height }),

    // 배경 이미지
    setBackgroundImage: (type, imageData) =>
      guarded('setBackgroundImage', async () => {
        await storeWrite(bgFile(type), imageData)
        return true
      }, false),
    getBackgroundImage: type =>
      guarded('getBackgroundImage', async () => {
        const bytes = await storeRead(bgFile(type))
        return bytes ? toDataUrl(bytes, 'image/png') : null
      }, null),
    removeBackgroundImage: type =>
      guarded('removeBackgroundImage', async () => {
        await invoke('store_remove', { name: bgFile(type) })
        return true
      }, false),
    selectBackgroundImage: () => pickFile('배경 이미지 선택', 'Images', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']),

    // 알림 소리
    setNotificationSound: audioData =>
      guarded('setNotificationSound', async () => {
        await storeWrite(CUSTOM_SOUND_FILE, audioData)
        return true
      }, false),
    getNotificationSound: () =>
      guarded('getNotificationSound', async () => {
        const bytes = await storeRead(CUSTOM_SOUND_FILE)
        return bytes ? toDataUrl(bytes, 'audio/mpeg') : null
      }, null),
    removeNotificationSound: () =>
      guarded('removeNotificationSound', async () => {
        await invoke('store_remove', { name: CUSTOM_SOUND_FILE })
        return true
      }, false),
    selectNotificationSound: () => pickFile('알림 소리 선택', 'Audio Files', ['mp3', 'wav', 'ogg', 'm4a', 'aac']),
    setNotificationVolume: volume => patchNotificationSettings({ volume }),
    getNotificationVolume: async () =>
      (await storeReadJson(NOTIFICATION_SETTINGS_FILE, DEFAULT_NOTIFICATION_SETTINGS)).volume,
    setNotificationEnabled: enabled => patchNotificationSettings({ enabled }),
    getNotificationEnabled: async () =>
      (await storeReadJson(NOTIFICATION_SETTINGS_FILE, DEFAULT_NOTIFICATION_SETTINGS)).enabled,

    // 시스템 이벤트
    onSystemResume: callback => {
      resumeCallbacks.add(callback)
      startResumeWatcher()
    },

    // 스타일 설정 (모든 창에 브로드캐스트)
    setStyleSettings: settings =>
      guarded('setStyleSettings', async () => {
        await storeWriteJson(STYLE_SETTINGS_FILE, settings)
        await emit('style-settings-changed', settings)
        return true
      }, false),
    getStyleSettings: () => storeReadJson<unknown | null>(STYLE_SETTINGS_FILE, null),
    onStyleSettingsChanged: callback => {
      void listen<unknown>('style-settings-changed', event => callback(event.payload))
    },
    notifyBackgroundChanged: bgType => void emit('background-changed', bgType),
    onBackgroundChanged: callback => {
      void listen<string>('background-changed', event => callback(event.payload))
    },

    // 업데이트
    checkForUpdates: checkForUpdate,
    getAppVersion: () => getVersion(),
  }
}

/** Tauri 환경이면 window.electronApi를 설치한다. 화면 코드보다 먼저 호출해야 한다. */
export function installTauriApi(): boolean {
  if (!('__TAURI_INTERNALS__' in window)) return false
  const api = createTauriApi()
  window.electronApi = api
  const w = window as unknown as Record<string, () => void>
  w.__electronWindowMinimize = api.windowMinimize
  w.__electronWindowMaximize = api.windowMaximize
  w.__electronWindowClose = api.windowClose

  installDragRegions()
  installTitlebar()

  // 업데이트 알림은 메인 창에서만 (창마다 중복으로 묻지 않도록)
  const label = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label
  if (label === 'main' && !import.meta.env.DEV) startAutoUpdate(message => api.showConfirm(message), url => api.openExternal(url))

  // F12: 개발자 도구 토글
  window.addEventListener('keydown', e => {
    if (e.key === 'F12') {
      e.preventDefault()
      void invoke('toggle_devtools')
    }
  })
  return true
}

/**
 * 프레임 없는 창 이동: CSS `-webkit-app-region: drag`(Electron 방식)를 읽어 Tauri startDragging으로 연결한다.
 * 조상 방향으로 올라가며 가장 가까운 drag / no-drag 지정을 따른다.
 */
function installDragRegions() {
  const INTERACTIVE = 'button, a, input, textarea, select, label, [contenteditable="true"], [data-no-drag]'
  window.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.defaultPrevented) return
    const target = e.target as HTMLElement | null
    if (!target || target.closest(INTERACTIVE)) return
    for (let el: HTMLElement | null = target; el; el = el.parentElement) {
      if (el.hasAttribute('data-tauri-drag-region')) break
      const region = getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
      if (region === 'no-drag') return
      if (region === 'drag') break
      if (!el.parentElement) return
    }
    void getCurrentWindow().startDragging()
  })
}
