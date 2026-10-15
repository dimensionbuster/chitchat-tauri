//! 시스템 트레이 (Electron Tray 대응): 홈 열기 / 채팅방 목록 / 모든 창 열기·숨기기 / 종료

use crate::state::AppState;
use crate::windows;
use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "main";

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "home", "홈 화면 열기", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let rooms: Vec<(String, String)> = app
        .state::<AppState>()
        .chat_rooms
        .lock()
        .unwrap()
        .iter()
        .map(|(room, label)| (room.clone(), label.clone()))
        .collect();
    if !rooms.is_empty() {
        let sub = Submenu::with_id(app, "rooms", "채팅방", true)?;
        for (room, label) in rooms {
            sub.append(&MenuItem::with_id(app, format!("room:{label}"), format!("📱 {room}"), true, None::<&str>)?)?;
        }
        menu.append(&sub)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    menu.append(&MenuItem::with_id(app, "show-all", "모든 창 열기", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "hide-all", "모든 창 숨기기", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?)?;
    Ok(menu)
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "home" => windows::show_main(app),
        "show-all" => windows::show_all(app),
        "hide-all" => windows::hide_all(app),
        "quit" => quit(app),
        other => {
            if let Some(label) = other.strip_prefix("room:") {
                windows::focus_label(app, label);
            }
        }
    }
}

pub fn quit(app: &AppHandle) {
    app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
    windows::save_last_opened_rooms(app);
    app.exit(0);
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ChitChat - 채팅 앱")
        .menu(&build_menu(app)?)
        .on_menu_event(on_menu_event);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 채팅방 창이 열리거나 닫힐 때 메뉴를 다시 만든다.
pub fn rebuild(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}
