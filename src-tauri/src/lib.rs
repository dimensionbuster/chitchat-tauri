mod adblock;
mod blobs;
mod power;
mod state;
mod storage;
mod tray;
mod windows;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 단일 인스턴스: 두 번째 실행 시 기존 앱의 메인 창을 띄운다 (가장 먼저 등록해야 함)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            windows::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState::default())
        .manage(blobs::BlobState::default())
        .invoke_handler(tauri::generate_handler![
            windows::open_chat_room,
            windows::show_main_window,
            windows::open_settings,
            windows::open_watch_party,
            windows::window_minimize,
            windows::window_maximize,
            windows::window_close,
            windows::window_destroy,
            windows::toggle_devtools,
            windows::open_external,
            windows::create_notification,
            windows::close_notification,
            windows::click_notification,
            windows::show_dialog,
            windows::close_dialog,
            windows::resize_and_show_dialog,
            storage::store_write,
            storage::store_read,
            storage::store_remove,
            storage::pick_file,
            blobs::blob_begin,
            blobs::blob_write,
            blobs::blob_read,
            blobs::blob_finalize,
            blobs::blob_stat,
            blobs::blob_path,
            blobs::blob_delete,
            blobs::blob_import_path,
            blobs::blob_save_as,
            blobs::blob_gc,
            blobs::blob_list,
            blobs::blob_sync,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            if cfg!(debug_assertions) {
                handle.plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            } else {
                // 개발 빌드 경로가 로그인 항목에 등록되지 않도록 릴리스에서만 자동 시작을 켠다.
                // 테스트/포터블 실행 시 CHITCHAT_NO_AUTOSTART=1 로 끌 수 있다.
                if std::env::var_os("CHITCHAT_NO_AUTOSTART").is_none() {
                    use tauri_plugin_autostart::ManagerExt;
                    let _ = handle.autolaunch().enable();
                }
            }

            power::prevent_system_sleep();
            windows::create_main(&handle)?;
            tray::create(&handle)?;

            // 메인 창이 완전히 뜬 뒤 마지막으로 열려 있던 채팅방 복원
            let restore = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                windows::restore_last_opened_rooms(&restore);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // 모든 창이 숨겨져도 트레이에 상주
            tauri::RunEvent::ExitRequested { api, .. } => {
                let quitting = app
                    .state::<AppState>()
                    .quitting
                    .load(std::sync::atomic::Ordering::SeqCst);
                if !quitting {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::Exit => windows::save_last_opened_rooms(app),
            _ => {}
        });
}
