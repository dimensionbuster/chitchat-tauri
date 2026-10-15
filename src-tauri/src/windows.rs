//! 창 생성/관리와 창 관련 IPC 커맨드.
//!
//! 주의: Windows에서 동기 커맨드 안에서 창을 만들면 데드락이 나므로 창을 만드는 커맨드는 모두 async.

use crate::state::{AppState, DialogEntry, label_for};
use crate::{adblock, storage, tray};
use std::sync::atomic::Ordering;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, async_runtime,
};
use tokio::sync::oneshot;

const NOTIFICATION_WIDTH: f64 = 300.0;
const NOTIFICATION_HEIGHT: f64 = 100.0;
const NOTIFICATION_AUTO_CLOSE_SECS: u64 = 15;
const LAST_ROOMS_FILE: &str = "last-opened-rooms.json";

/// WebView2 환경은 같은 user-data-dir를 쓰는 모든 창이 동일한 인자를 가져야 한다.
/// 백그라운드(숨김/가려진) 창에서도 타이머와 WebRTC가 스로틀링되지 않도록 한다.
#[cfg(windows)]
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --disable-background-timer-throttling --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows";

fn route_url(app: &AppHandle, route: &str) -> WebviewUrl {
    if cfg!(debug_assertions) {
        if let Some(dev) = app.config().build.dev_url.clone() {
            let base = dev.as_str().trim_end_matches('/');
            if let Ok(url) = Url::parse(&format!("{base}#{route}")) {
                return WebviewUrl::External(url);
            }
        }
    }
    WebviewUrl::App(format!("index.html#{route}").into())
}

fn builder<'a>(app: &'a AppHandle, label: &str, route: &str) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let b = WebviewWindowBuilder::new(app, label, route_url(app, route)).decorations(false);
    #[cfg(windows)]
    let b = b.additional_browser_args(BROWSER_ARGS);
    b
}

fn enc(s: &str) -> String {
    // 쿼리 값 인코딩 (encodeURIComponent 상당)
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn focus(window: &WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// 닫기 버튼은 창을 숨기기만 하고 앱은 계속 실행한다(트레이 상주). 진짜 종료 중이면 그대로 닫는다.
fn hide_on_close(window: &WebviewWindow) {
    let w = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let quitting = w.state::<AppState>().quitting.load(Ordering::SeqCst);
            if !quitting {
                api.prevent_close();
                let _ = w.hide();
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 메인 / 채팅방 / 설정 / 와치파티
// ---------------------------------------------------------------------------

pub fn show_main(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) => focus(&w),
        None => {
            let app = app.clone();
            async_runtime::spawn(async move {
                let _ = create_main(&app);
            });
        }
    }
}

pub fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window("main") {
        focus(&w);
        return Ok(w);
    }
    let w = builder(app, "main", "/")
        .title("ChitChat")
        .inner_size(410.0, 700.0)
        .build()?;
    adblock::install(&w);
    hide_on_close(&w);
    Ok(w)
}

pub fn open_chat_room_window(app: &AppHandle, room_id: &str, user_name: Option<&str>) -> tauri::Result<()> {
    let label = label_for("chat", room_id);
    if let Some(existing) = app.get_webview_window(&label) {
        focus(&existing);
        return Ok(());
    }

    let mut route = format!("/chat?roomId={}", enc(room_id));
    if let Some(name) = user_name.filter(|n| !n.is_empty()) {
        route.push_str(&format!("&name={}", enc(name)));
    }
    let w = builder(app, &label, &route)
        .title(format!("ChitChat - {room_id}"))
        .inner_size(900.0, 700.0)
        .build()?;
    adblock::install(&w);
    hide_on_close(&w);

    app.state::<AppState>()
        .chat_rooms
        .lock()
        .unwrap()
        .insert(room_id.to_string(), label);
    tray::rebuild(app);
    save_last_opened_rooms(app);

    let app2 = app.clone();
    let room = room_id.to_string();
    w.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            app2.state::<AppState>().chat_rooms.lock().unwrap().remove(&room);
            tray::rebuild(&app2);
            if !app2.state::<AppState>().quitting.load(Ordering::SeqCst) {
                save_last_opened_rooms(&app2);
            }
        }
    });
    Ok(())
}

pub fn save_last_opened_rooms(app: &AppHandle) {
    let rooms: Vec<String> = app
        .state::<AppState>()
        .chat_rooms
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    storage::write_json(app, LAST_ROOMS_FILE, &rooms);
}

pub fn restore_last_opened_rooms(app: &AppHandle) {
    let rooms: Vec<String> = storage::read_json(app, LAST_ROOMS_FILE).unwrap_or_default();
    for (i, room) in rooms.into_iter().enumerate() {
        let app = app.clone();
        async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200 * i as u64)).await;
            let _ = open_chat_room_window(&app, &room, None);
        });
    }
}

pub fn show_all(app: &AppHandle) {
    show_main(app);
    for label in app.state::<AppState>().chat_rooms.lock().unwrap().values() {
        if let Some(w) = app.get_webview_window(label) {
            focus(&w);
        }
    }
}

pub fn hide_all(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    for label in app.state::<AppState>().chat_rooms.lock().unwrap().values() {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
}

pub fn focus_label(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        focus(&w);
    }
}

#[tauri::command]
pub async fn open_chat_room(app: AppHandle, room_id: String, user_name: Option<String>) -> Result<(), String> {
    open_chat_room_window(&app, &room_id, user_name.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn show_main_window(app: AppHandle) -> Result<(), String> {
    create_main(&app).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_settings(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("settings") {
        focus(&existing);
        return Ok(());
    }
    builder(&app, "settings", "/settings")
        .title("ChitChat 설정")
        .inner_size(720.0, 700.0)
        .maximizable(false)
        .parent(&window)
        .map_err(|e| e.to_string())?
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_watch_party(
    app: AppHandle,
    room_id: String,
    youtube_url: Option<String>,
    user_name: Option<String>,
) -> Result<(), String> {
    let label = label_for("watch", &room_id);
    if let Some(existing) = app.get_webview_window(&label) {
        focus(&existing);
        // 이미 열려 있으면 새 URL만 전달
        if let Some(url) = youtube_url {
            let _ = tauri::Emitter::emit_to(&app, label.as_str(), "watch-party:load-youtube-url", url);
        }
        return Ok(());
    }

    let mut route = format!("/watch-party?roomId={}", enc(&room_id));
    if let Some(url) = youtube_url.as_deref() {
        route.push_str(&format!("&youtubeUrl={}", enc(url)));
    }
    if let Some(name) = user_name.as_deref() {
        route.push_str(&format!("&userName={}", enc(name)));
    }
    let w = builder(&app, &label, &route)
        .title("ChitChat Watch Party")
        .inner_size(1200.0, 720.0)
        .min_inner_size(854.0, 480.0)
        .background_color(tauri::window::Color(0x1a, 0x1a, 0x1a, 0xff))
        .build()
        .map_err(|e| e.to_string())?;
    adblock::install(&w);

    app.state::<AppState>()
        .watch_parties
        .lock()
        .unwrap()
        .insert(room_id.clone(), label);
    let app2 = app.clone();
    w.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            app2.state::<AppState>().watch_parties.lock().unwrap().remove(&room_id);
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// 창 제어 (호출한 창 기준)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn window_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub fn window_destroy(window: WebviewWindow) {
    let _ = window.destroy();
}

#[tauri::command]
pub fn toggle_devtools(window: WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) {
    // 보안: http, https, ftp만 허용
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("ftp://") {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

// ---------------------------------------------------------------------------
// 알림 창
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn create_notification(
    app: AppHandle,
    author_name: String,
    text: String,
    message_id: String,
    room_id: String,
) -> Result<(), String> {
    let label = format!("notification-{}", label_for("n", &format!("{message_id}{}", now_nanos())));
    let route = format!(
        "/notification?authorName={}&text={}&messageId={}&roomId={}",
        enc(&author_name),
        enc(&text),
        enc(&message_id),
        enc(&room_id)
    );

    // 주 모니터 작업 영역(작업 표시줄 제외)의 우측 하단
    let (x, y) = match app.primary_monitor().ok().flatten() {
        Some(m) => {
            let scale = m.scale_factor();
            let wa = m.work_area();
            (
                (wa.position.x as f64 + wa.size.width as f64) / scale - NOTIFICATION_WIDTH - 10.0,
                (wa.position.y as f64 + wa.size.height as f64) / scale - NOTIFICATION_HEIGHT - 10.0,
            )
        }
        None => (100.0, 100.0),
    };

    let window = builder(&app, &label, &route)
        .inner_size(NOTIFICATION_WIDTH, NOTIFICATION_HEIGHT)
        .position(x, y)
        .always_on_top(true)
        .transparent(true)
        .skip_taskbar(true)
        .resizable(false)
        .focusable(false)
        .focused(false)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;

    // 렌더러가 멈춰도 자동으로 닫히는 안전 장치
    let w = window.clone();
    async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(NOTIFICATION_AUTO_CLOSE_SECS)).await;
        let _ = w.destroy();
    });
    Ok(())
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[tauri::command]
pub fn close_notification(app: AppHandle) {
    // 가장 최근에 만든 알림 창을 닫는다 (label 사전순 = 시간순이 아니므로 하나만 골라 닫는다)
    let mut windows: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("notification-"))
        .collect();
    windows.sort_by(|a, b| a.0.cmp(&b.0));
    if let Some((_, w)) = windows.pop() {
        let _ = w.destroy();
    }
}

#[tauri::command]
pub async fn click_notification(app: AppHandle, room_id: Option<String>, user_name: Option<String>) -> Result<(), String> {
    match room_id.filter(|r| !r.is_empty()) {
        Some(room) => open_chat_room_window(&app, &room, user_name.as_deref()).map_err(|e| e.to_string()),
        None => create_main(&app).map(|_| ()).map_err(|e| e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// 커스텀 다이얼로그 (alert / confirm)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn show_dialog(app: AppHandle, window: WebviewWindow, message: String, kind: String) -> Result<bool, String> {
    let dialog_id = format!("{}", now_nanos());
    let label = format!("dialog-{dialog_id}");
    let route = format!(
        "/dialog?message={}&type={}&dialogId={}",
        enc(&message),
        enc(&kind),
        enc(&dialog_id)
    );

    let (tx, rx) = oneshot::channel::<bool>();
    app.state::<AppState>().dialogs.lock().unwrap().insert(
        dialog_id.clone(),
        DialogEntry {
            label: label.clone(),
            parent_label: window.label().to_string(),
            tx: Some(tx),
        },
    );

    // 크기는 Vue가 측정한 뒤 resize_and_show_dialog로 정하고 그때 표시한다.
    let built = builder(&app, &label, &route)
        .inner_size(100.0, 100.0)
        .always_on_top(true)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .skip_taskbar(true)
        .visible(false)
        .parent(&window)
        .map_err(|e| e.to_string())?
        .build();

    let dialog_window = match built {
        Ok(w) => w,
        Err(e) => {
            app.state::<AppState>().dialogs.lock().unwrap().remove(&dialog_id);
            return Err(e.to_string());
        }
    };

    // 창이 닫히면 취소(false)로 간주
    let app2 = app.clone();
    let id2 = dialog_id.clone();
    dialog_window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            if let Some(mut entry) = app2.state::<AppState>().dialogs.lock().unwrap().remove(&id2) {
                if let Some(tx) = entry.tx.take() {
                    let _ = tx.send(false);
                }
            }
        }
    });

    Ok(rx.await.unwrap_or(false))
}

#[tauri::command]
pub fn close_dialog(app: AppHandle, dialog_id: String, result: bool) {
    let entry = app.state::<AppState>().dialogs.lock().unwrap().remove(&dialog_id);
    if let Some(mut entry) = entry {
        if let Some(tx) = entry.tx.take() {
            let _ = tx.send(result);
        }
        if let Some(w) = app.get_webview_window(&entry.label) {
            let _ = w.destroy();
        }
    }
}

#[tauri::command]
pub fn resize_and_show_dialog(app: AppHandle, dialog_id: String, width: f64, height: f64) {
    let (label, parent_label) = {
        let state = app.state::<AppState>();
        let dialogs = state.dialogs.lock().unwrap();
        match dialogs.get(&dialog_id) {
            Some(e) => (e.label.clone(), e.parent_label.clone()),
            None => return,
        }
    };
    let Some(dialog) = app.get_webview_window(&label) else { return };
    let _ = dialog.set_size(LogicalSize::new(width, height));

    // 부모 창 중앙, 부모가 없으면 주 모니터 중앙
    let center = app
        .get_webview_window(&parent_label)
        .and_then(|p| {
            let scale = p.scale_factor().ok()?;
            let pos = p.outer_position().ok()?;
            let size = p.outer_size().ok()?;
            Some((
                (pos.x as f64 + size.width as f64 / 2.0) / scale,
                (pos.y as f64 + size.height as f64 / 2.0) / scale,
            ))
        })
        .or_else(|| {
            let m = app.primary_monitor().ok().flatten()?;
            let scale = m.scale_factor();
            let wa = m.work_area();
            Some((
                (wa.position.x as f64 + wa.size.width as f64 / 2.0) / scale,
                (wa.position.y as f64 + wa.size.height as f64 / 2.0) / scale,
            ))
        });
    if let Some((cx, cy)) = center {
        let _ = dialog.set_position(LogicalPosition::new(cx - width / 2.0, cy - height / 2.0));
    }
    let _ = dialog.show();
    let _ = dialog.set_focus();
}
