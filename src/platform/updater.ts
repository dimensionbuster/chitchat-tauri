/**
 * 업데이트 알림 (수동 설치).
 * GitHub Releases의 최신 릴리스 태그만 조회해 새 버전을 알려 주고, 설치는 다운로드 페이지에서 사용자가 직접 한다.
 * 앱이 파일을 내려받아 실행하지 않으므로 서명키가 필요 없다.
 */

import { getVersion } from '@tauri-apps/api/app'

export type UpdateCheckResult = {
  available: boolean
  message: string
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
}

const LATEST_RELEASE_API = 'https://api.github.com/repos/dimensionbuster/chitchat-tauri/releases/latest'
const RELEASE_URL_PREFIX = 'https://github.com/dimensionbuster/chitchat-tauri/releases/'
const AUTO_CHECK_DELAY_MS = 30_000
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const parseVersion = (v: string) => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)

/** a가 b보다 높으면 true */
function isNewer(a: string, b: string): boolean {
  const [pa, pb] = [parseVersion(a), parseVersion(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = await getVersion()
  try {
    const res = await fetch(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const release = (await res.json()) as { tag_name?: string; html_url?: string }
    const latestVersion = release.tag_name?.replace(/^v/, '') ?? null
    if (latestVersion && isNewer(latestVersion, currentVersion)) {
      // 응답에서 받은 URL은 이 저장소의 릴리스 주소일 때만 쓴다
      const releaseUrl = release.html_url?.startsWith(RELEASE_URL_PREFIX) ? release.html_url : null
      return {
        available: true,
        message: `새 버전이 있습니다!\n현재: v${currentVersion}\n최신: v${latestVersion}`,
        currentVersion,
        latestVersion,
        releaseUrl,
      }
    }
    return {
      available: false,
      message: `최신 버전입니다. (v${currentVersion})`,
      currentVersion,
      latestVersion: latestVersion ?? currentVersion,
      releaseUrl: null,
    }
  } catch (error) {
    console.error('[updater] 확인 실패:', error)
    return {
      available: false,
      message: '업데이트 확인 중 오류가 발생했습니다.',
      currentVersion,
      latestVersion: null,
      releaseUrl: null,
    }
  }
}

/**
 * 백그라운드 확인: 시작 30초 뒤 한 번, 이후 6시간마다.
 * 새 버전이면 한 번 물어보고, 동의하면 다운로드 페이지를 연다. 거절한 버전은 다시 묻지 않는다.
 */
export function startAutoUpdate(
  ask: (message: string) => Promise<boolean>,
  openPage: (url: string) => void,
) {
  let declined: string | null = null

  const run = async () => {
    const result = await checkForUpdate()
    if (!result.available || !result.latestVersion || result.latestVersion === declined) return
    const yes = await ask(`새 버전 v${result.latestVersion}이 있습니다.\n다운로드 페이지를 열까요?`)
    if (!yes) {
      declined = result.latestVersion
      return
    }
    if (result.releaseUrl) openPage(result.releaseUrl)
  }

  setTimeout(() => {
    void run().catch(error => console.error('[updater] 자동 확인 실패:', error))
    setInterval(() => {
      void run().catch(error => console.error('[updater] 자동 확인 실패:', error))
    }, AUTO_CHECK_INTERVAL_MS)
  }, AUTO_CHECK_DELAY_MS)
}
