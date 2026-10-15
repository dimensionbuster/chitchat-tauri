//! 앱 데이터 디렉터리 안의 파일 저장소 (배경 이미지, 알림음, 설정 JSON 등).
//! 파일 이름은 단일 세그먼트만 허용해 디렉터리 탈출을 막는다.

use std::fs;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn safe_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.starts_with('.');
    if !ok {
        return Err(format!("invalid file name: {name}"));
    }
    Ok(data_dir(app)?.join(name))
}

pub fn read_json<T: serde::de::DeserializeOwned>(app: &AppHandle, name: &str) -> Option<T> {
    let path = safe_path(app, name).ok()?;
    let data = fs::read(path).ok()?;
    serde_json::from_slice(&data).ok()
}

pub fn write_json<T: serde::Serialize>(app: &AppHandle, name: &str, value: &T) {
    if let Ok(path) = safe_path(app, name) {
        if let Ok(data) = serde_json::to_vec_pretty(value) {
            let _ = fs::write(path, data);
        }
    }
}

/// 바이너리 저장. 파일 이름은 `x-name` 헤더, 내용은 raw body로 받는다.
#[tauri::command]
pub fn store_write(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-name header")?
        .to_string();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    fs::write(safe_path(&app, &name)?, bytes).map_err(|e| e.to_string())
}

/// 파일이 없으면 Err("not-found")
#[tauri::command]
pub fn store_read(app: AppHandle, name: String) -> Result<Response, String> {
    let path = safe_path(&app, &name)?;
    match fs::read(path) {
        Ok(bytes) => Ok(Response::new(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("not-found".into()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn store_remove(app: AppHandle, name: String) -> Result<(), String> {
    let path = safe_path(&app, &name)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 파일 선택 다이얼로그를 열어 선택한 파일의 바이트를 반환한다. 취소하면 Err("cancelled").
#[tauri::command]
pub async fn pick_file(
    app: AppHandle,
    title: String,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Response, String> {
    use tauri_plugin_dialog::DialogExt;
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let picked = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(filter_name, &exts)
        .blocking_pick_file();
    let Some(file) = picked else {
        return Err("cancelled".into());
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    fs::read(path).map(Response::new).map_err(|e| e.to_string())
}
