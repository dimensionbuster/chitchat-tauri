/**
 * 자동 업데이트 (tauri-plugin-updater).
 * 업데이트 정보(latest.json)는 GitHub Releases에서 받고, 설치 파일은 서명 검증 후 설치한다.
 * 설정(공개키/엔드포인트)은 src-tauri/tauri.conf.json의 plugins.updater에 있다. 릴리스 절차는 docs/RELEASE.md.
 */

import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getVersion } from '@tauri-apps/api/app'

export type UpdateCheckResult = {
  available: boolean
  message: string
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
  /** true면 앱 안에서 바로 설치할 수 있다 */
  canInstall: boolean
}

const AUTO_CHECK_DELAY_MS = 30_000
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let pending: Update | null = null

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = await getVersion()
  try {
    const update = await check()
    if (update) {
      pending = update
      return {
        available: true,
        message: `새 버전이 있습니다!\n현재: v${currentVersion}\n최신: v${update.version}`,
        currentVersion,
        latestVersion: update.version,
        releaseUrl: null,
        canInstall: true,
      }
    }
    pending = null
    return {
      available: false,
      message: `최신 버전입니다. (v${currentVersion})`,
      currentVersion,
      latestVersion: currentVersion,
      releaseUrl: null,
      canInstall: false,
    }
  } catch (error) {
    console.error('[updater] 확인 실패:', error)
    return {
      available: false,
      message: '업데이트 확인 중 오류가 발생했습니다.',
      currentVersion,
      latestVersion: null,
      releaseUrl: null,
      canInstall: false,
    }
  }
}

/** 마지막으로 확인된 업데이트를 내려받아 설치하고 앱을 다시 시작한다. */
export async function installUpdate(): Promise<void> {
  if (!pending) {
    const result = await checkForUpdate()
    if (!result.available) throw new Error('설치할 업데이트가 없습니다')
  }
  await pending!.downloadAndInstall()
  await relaunch()
}

/**
 * 백그라운드 자동 확인: 시작 30초 뒤 한 번, 이후 6시간마다.
 * 새 버전이 있으면 한 번 물어보고, 동의하면 설치한다. 거절한 버전은 다시 묻지 않는다.
 */
export function startAutoUpdate(ask: (message: string) => Promise<boolean>) {
  let declined: string | null = null

  const run = async () => {
    const result = await checkForUpdate()
    if (!result.available || !result.latestVersion || result.latestVersion === declined) return
    const yes = await ask(`새 버전 v${result.latestVersion}이 있습니다.\n지금 설치하고 다시 시작할까요?`)
    if (!yes) {
      declined = result.latestVersion
      return
    }
    await installUpdate()
  }

  setTimeout(() => {
    void run().catch(error => console.error('[updater] 자동 업데이트 실패:', error))
    setInterval(() => {
      void run().catch(error => console.error('[updater] 자동 업데이트 실패:', error))
    }, AUTO_CHECK_INTERVAL_MS)
  }, AUTO_CHECK_DELAY_MS)
}
