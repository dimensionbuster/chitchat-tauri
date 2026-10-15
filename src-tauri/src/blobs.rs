//! 콘텐츠 주소 지정 블롭 저장소 (디스크 스트리밍).
//!
//! 파일은 SHA-256 해시를 id로 `app_data/blobs/<id>`에 저장한다. 수신 중인 파일은 `<id>.part`에
//! 미리 크기를 잡아두고 청크를 위치(offset)에 직접 쓴다. 전체를 메모리에 모으지 않으므로 수십 GB도 처리한다.
//! 완료 시 해시를 스트리밍으로 검증한 뒤에만 `<id>`로 확정(rename)한다.

use crate::storage::data_dir;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, State};

const HASH_BUF: usize = 1024 * 1024;
const PROGRESS_EVERY: u64 = 16 * 1024 * 1024;
const MIN_FREE_MARGIN: u64 = 256 * 1024 * 1024;

#[derive(Default)]
pub struct BlobState {
    /// 쓰기 중인 `.part` 파일 핸들 (청크마다 다시 열지 않도록 캐시)
    handles: Mutex<HashMap<String, Arc<File>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobStatus {
    /// "complete" | "partial" | "new"
    pub state: &'static str,
    pub size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportedBlob {
    pub id: String,
    pub size: u64,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BlobProgress<'a> {
    op: &'a str,
    id: &'a str,
    done: u64,
    total: u64,
}

fn blobs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("blobs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn valid_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(format!("invalid blob id: {id}")) }
}

fn final_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    Ok(blobs_dir(app)?.join(id))
}

fn part_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    Ok(blobs_dir(app)?.join(format!("{id}.part")))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(windows)]
fn write_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0;
    while done < buf.len() {
        let n = file.seek_write(&buf[done..], offset + done as u64)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        done += n;
    }
    Ok(())
}

#[cfg(unix)]
fn write_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.write_all_at(buf, offset)
}

#[cfg(windows)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(buf, offset)
}

#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.read_at(buf, offset)
}

fn hash_file(path: &PathBuf, mut on_progress: impl FnMut(u64)) -> Result<(String, u64), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_BUF];
    let mut total = 0u64;
    let mut since_report = 0u64;
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
        since_report += n as u64;
        if since_report >= PROGRESS_EVERY {
            since_report = 0;
            on_progress(total);
        }
    }
    Ok((hex(&hasher.finalize()), total))
}

fn open_part(app: &AppHandle, state: &BlobState, id: &str) -> Result<Arc<File>, String> {
    if let Some(f) = state.handles.lock().unwrap().get(id) {
        return Ok(f.clone());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(part_path(app, id)?)
        .map_err(|e| e.to_string())?;
    let file = Arc::new(file);
    state.handles.lock().unwrap().insert(id.to_string(), file.clone());
    Ok(file)
}

fn emit_progress(app: &AppHandle, op: &str, id: &str, done: u64, total: u64) {
    let _ = app.emit("blob-progress", BlobProgress { op, id, done, total });
}

/// 수신 시작. 이미 완성본이 있으면 "complete", 없으면 `.part`를 (필요시 크기를 맞춰) 준비한다.
#[tauri::command]
pub fn blob_begin(app: AppHandle, state: State<'_, BlobState>, id: String, size: u64) -> Result<BlobStatus, String> {
    if final_path(&app, &id)?.exists() {
        let size = fs::metadata(final_path(&app, &id)?).map(|m| m.len()).unwrap_or(size);
        return Ok(BlobStatus { state: "complete", size });
    }
    let part = part_path(&app, &id)?;
    let existed = part.exists();

    if !existed {
        let free = fs4::available_space(blobs_dir(&app)?).map_err(|e| e.to_string())?;
        if free < size.saturating_add(MIN_FREE_MARGIN) {
            return Err("no-space".into());
        }
    }

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&part)
        .map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != size {
        file.set_len(size).map_err(|e| e.to_string())?;
    }
    state.handles.lock().unwrap().insert(id, Arc::new(file));
    Ok(BlobStatus { state: if existed { "partial" } else { "new" }, size })
}

/// 청크 쓰기. 헤더 `x-id`, `x-offset`, 본문은 raw 바이트.
#[tauri::command]
pub fn blob_write(app: AppHandle, state: State<'_, BlobState>, request: Request<'_>) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| format!("missing {name} header"))
    };
    let id = header("x-id")?;
    let offset: u64 = header("x-offset")?.parse().map_err(|_| "bad x-offset".to_string())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    let file = open_part(&app, &state, &id)?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if offset + bytes.len() as u64 > len {
        return Err("write out of range".into());
    }
    write_at(&file, bytes, offset).map_err(|e| e.to_string())
}

/// 구간 읽기 (완성본 우선, 없으면 `.part`).
#[tauri::command]
pub fn blob_read(app: AppHandle, id: String, offset: u64, len: u64) -> Result<Response, String> {
    let path = {
        let f = final_path(&app, &id)?;
        if f.exists() { f } else { part_path(&app, &id)? }
    };
    let file = File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { "not-found".to_string() } else { e.to_string() }
    })?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if offset >= size {
        return Ok(Response::new(Vec::new()));
    }
    let want = len.min(size - offset) as usize;
    let mut out = vec![0u8; want];
    let mut filled = 0;
    while filled < want {
        let n = read_at(&file, &mut out[filled..], offset + filled as u64).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    out.truncate(filled);
    Ok(Response::new(out))
}

/// 수신 완료 확정. `expected`가 있으면 해시가 일치할 때만 `<id>`로 rename한다.
/// `adopt`가 true면 해시를 id로 삼아 rename하고 해시를 반환한다(로컬 파일 가져오기용).
#[tauri::command]
pub async fn blob_finalize(
    app: AppHandle,
    state: State<'_, BlobState>,
    id: String,
    expected: Option<String>,
    adopt: bool,
) -> Result<String, String> {
    let part = part_path(&app, &id)?;
    state.handles.lock().unwrap().remove(&id);

    let app2 = app.clone();
    let id2 = id.clone();
    let part2 = part.clone();
    let (hash, total) = tauri::async_runtime::spawn_blocking(move || {
        hash_file(&part2, |done| emit_progress(&app2, "verify", &id2, done, 0))
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Some(expected) = expected.as_deref() {
        if !expected.eq_ignore_ascii_case(&hash) {
            return Err(format!("hash-mismatch:{hash}"));
        }
    }
    let target_id = if adopt { hash.clone() } else { id.clone() };
    let target = final_path(&app, &target_id)?;
    if target.exists() {
        let _ = fs::remove_file(&part);
    } else {
        fs::rename(&part, &target).map_err(|e| e.to_string())?;
    }
    emit_progress(&app, "verify", &id, total, total);
    Ok(hash)
}

#[tauri::command]
pub fn blob_stat(app: AppHandle, id: String) -> Result<BlobStatus, String> {
    let f = final_path(&app, &id)?;
    if let Ok(m) = fs::metadata(&f) {
        return Ok(BlobStatus { state: "complete", size: m.len() });
    }
    if let Ok(m) = fs::metadata(part_path(&app, &id)?) {
        return Ok(BlobStatus { state: "partial", size: m.len() });
    }
    Ok(BlobStatus { state: "new", size: 0 })
}

/// 완성된 블롭의 절대 경로 (프론트에서 asset 프로토콜 URL로 변환해 <img>/<video>에 바로 사용).
#[tauri::command]
pub fn blob_path(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let f = final_path(&app, &id)?;
    Ok(f.exists().then(|| f.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn blob_delete(app: AppHandle, state: State<'_, BlobState>, id: String) -> Result<(), String> {
    state.handles.lock().unwrap().remove(&id);
    for path in [final_path(&app, &id)?, part_path(&app, &id)?] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// 디스크 경로의 파일을 저장소로 가져온다 (복사하면서 해시 계산). 메모리에 올리지 않는다.
#[tauri::command]
pub async fn blob_import_path(app: AppHandle, path: String) -> Result<ImportedBlob, String> {
    let name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let dir = blobs_dir(&app)?;
    let tmp_id = format!("imp-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let tmp = dir.join(format!("{tmp_id}.part"));
    let app2 = app.clone();
    let tmp_task = tmp.clone();

    let (hash, size) = tauri::async_runtime::spawn_blocking(move || -> Result<(String, u64), String> {
        let mut src = File::open(&path).map_err(|e| format!("open source {path}: {e}"))?;
        let total = src.metadata().map_err(|e| e.to_string())?.len();
        let free = fs4::available_space(&dir).map_err(|e| format!("disk space {}: {e}", dir.display()))?;
        if free < total.saturating_add(MIN_FREE_MARGIN) {
            return Err("no-space".into());
        }
        let mut dst = File::create(&tmp_task).map_err(|e| format!("create {}: {e}", tmp_task.display()))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; HASH_BUF];
        let (mut done, mut since) = (0u64, 0u64);
        loop {
            let n = src.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            dst.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            since += n as u64;
            if since >= PROGRESS_EVERY {
                since = 0;
                emit_progress(&app2, "import", &tmp_id, done, total);
            }
        }
        dst.flush().map_err(|e| e.to_string())?;
        Ok((hex(&hasher.finalize()), done))
    })
    .await
    .map_err(|e| e.to_string())??;

    let target = final_path(&app, &hash)?;
    if target.exists() {
        let _ = fs::remove_file(&tmp);
    } else {
        fs::rename(&tmp, &target).map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), target.display()))?;
    }
    Ok(ImportedBlob { id: hash, size, name })
}

/// 저장 위치를 물어 블롭을 복사한다. 취소하면 None.
#[tauri::command]
pub async fn blob_save_as(app: AppHandle, id: String, suggested_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let src = final_path(&app, &id)?;
    if !src.exists() {
        return Err("not-found".into());
    }
    let Some(dest) = app.dialog().file().set_file_name(suggested_name).blocking_save_file() else {
        return Ok(None);
    };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || fs::copy(src, dest2).map(|_| ()).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(dest.to_string_lossy().to_string()))
}

/// 저장소 정리: `keep`에 없는 블롭과 오래된 `.part`를 지운다. 삭제한 개수를 반환한다.
#[tauri::command]
pub fn blob_gc(app: AppHandle, keep: Vec<String>, max_part_age_secs: u64) -> Result<u32, String> {
    let keep: std::collections::HashSet<String> = keep.into_iter().collect();
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for entry in fs::read_dir(blobs_dir(&app)?).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let remove = match name.strip_suffix(".part") {
            Some(_) => entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .map(|age| age.as_secs() > max_part_age_secs)
                .unwrap_or(false),
            None => !keep.contains(&name),
        };
        if remove && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 완성된 블롭 id 목록 (피어에게 보유 파일을 알릴 때 사용).
#[tauri::command]
pub fn blob_list(app: AppHandle) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    for entry in fs::read_dir(blobs_dir(&app)?).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".part") && valid_id(&name).is_ok() {
            ids.push(name);
        }
    }
    Ok(ids)
}

/// 쓰기 중인 파일의 내용을 디스크에 flush한다 (이어받기 비트맵을 저장하기 직전에 호출).
#[tauri::command]
pub fn blob_sync(app: AppHandle, state: State<'_, BlobState>, id: String) -> Result<(), String> {
    let file = open_part(&app, &state, &id)?;
    file.sync_data().map_err(|e| e.to_string())
}
