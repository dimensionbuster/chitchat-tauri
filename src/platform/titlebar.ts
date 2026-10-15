/**
 * 커스텀 타이틀바 (프레임 없는 창용).
 * Electron 버전에서 preload가 주입하던 32px 바를 그대로 이식했다:
 * 왼쪽 드래그 영역 + 최소화/최대화/닫기 버튼. 알림/다이얼로그/와치파티 창은 자체 UI가 있어 제외한다.
 */

import { invoke } from '@tauri-apps/api/core'

const STYLE_ID = 'app-custom-titlebar-styles'
const BAR_ID = 'app-custom-titlebar'
const SKIP_ROUTES = ['/notification', '/dialog', '/watch-party']

const CSS = `
  #${BAR_ID} {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 32px;
    background: #2f3241;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0;
    z-index: 999999;
    user-select: none;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  #${BAR_ID} .titlebar-drag-area {
    flex: 1;
    display: flex;
    align-items: center;
    height: 100%;
    padding-left: 12px;
    -webkit-app-region: drag;
  }
  #${BAR_ID} .titlebar-title {
    font-size: 13px;
    font-weight: 500;
  }
  #${BAR_ID} .titlebar-controls {
    display: flex;
    height: 100%;
    -webkit-app-region: no-drag;
  }
  #${BAR_ID} .titlebar-button {
    width: 46px;
    height: 32px;
    border: none;
    background: transparent;
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.15s ease;
    padding: 0;
  }
  #${BAR_ID} .titlebar-button:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  #${BAR_ID} .titlebar-button.close:hover {
    background: #e81123;
  }
  body {
    padding-top: 32px !important;
  }
`

const HTML = `
  <div class="titlebar-drag-area">
    <span class="titlebar-title">ChitChat</span>
  </div>
  <div class="titlebar-controls">
    <button class="titlebar-button minimize" type="button" title="최소화">
      <svg width="12" height="12" viewBox="0 0 12 12"><rect y="5" width="12" height="1" fill="currentColor" /></svg>
    </button>
    <button class="titlebar-button maximize" type="button" title="최대화">
      <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1" /></svg>
    </button>
    <button class="titlebar-button close" type="button" title="닫기">
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1L11 11M11 1L1 11" stroke="currentColor" stroke-width="1" /></svg>
    </button>
  </div>
`

function inject() {
  if (document.getElementById(BAR_ID) || !document.body) return
  if (SKIP_ROUTES.some(route => window.location.hash.includes(route))) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)

  const bar = document.createElement('div')
  bar.id = BAR_ID
  bar.innerHTML = HTML
  document.body.insertBefore(bar, document.body.firstChild)

  const on = (selector: string, command: string) => {
    bar.querySelector(selector)?.addEventListener(
      'click',
      e => {
        e.preventDefault()
        e.stopPropagation()
        void invoke(command)
      },
      true,
    )
  }
  on('.minimize', 'window_minimize')
  on('.maximize', 'window_maximize')
  on('.close', 'window_close')

  // 일반 창처럼 타이틀바 더블클릭으로 최대화/복원
  bar.querySelector('.titlebar-drag-area')?.addEventListener('dblclick', () => {
    void invoke('window_maximize')
  })
}

export function installTitlebar() {
  const run = () => setTimeout(inject, 50)
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }
}
